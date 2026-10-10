// issuechan core: an MCP server (stdio) that long-polls the issue-channel server for /bot comments on
// subscribed GitHub issues and hands each delivery to the harness adapter, which pushes it into the
// running agent session. Harness-neutral: everything Claude Code- or Codex-specific is in adapters/.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { BOT_MARKER, IssueBuffer, formatDelivery, formatReply, isForSession, isGitHub, isLinear, issueLabel, replyTag, resolveAgent } from './lib.mjs'
import { ghApi, ghComment, myLogin } from './github.mjs'
import * as linear from './linear.mjs'

const log = (...a) => console.error('[issuechan]', ...a)

function readEnvFile(file) {
  try {
    return Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n')
      .map(l => l.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]))
  } catch { return {} }
}

// Adapter contract (see adapters/README.md):
//   name           harness name for logs
//   agentEnv       [[agentTag, ENV_VAR]]: where the harness puts its session id (ISSUECHAN_AGENT_ID overrides)
//   agentFromCall  optional (callParams) => { agent, id } | null: for harnesses that pass the session id
//                  only with tool calls; the first call that yields one binds this process to it
//   onBind         optional (agent, { stateDir }): called when a tool call binds the process
//   agentAtStart   optional async ({ stateDir }) => { agent, id } | null: bind before any tool call
//                  (e.g. after a harness restart), so saved subscriptions auto-resume
//   capabilities   extra MCP server capabilities (e.g. Claude Code's channel capability)
//   arrival        first sentence of the instructions: how deliveries show up in the session
//   resumeDelayMs  default wait after `initialized` before auto-resume may deliver
//   deliver(mcp, { content, meta }, { agent })  push one /bot delivery into the session
export async function runIssuechan(adapter) {
  const ENV_FILE = process.env.ISSUECHAN_ENV_FILE ?? path.join(os.homedir(), '.local/share/issue-channel/.env')
  const BASE_URL = (process.env.ISSUECHAN_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
  const API_KEY = process.env.ISSUECHAN_API_KEY ?? readEnvFile(ENV_FILE).API_KEY
  const STATE_DIR = process.env.ISSUECHAN_STATE_DIR ?? path.join(os.homedir(), '.local/state/issue-channel')
  const ALLOWED = (process.env.ISSUECHAN_ALLOWED_AUTHORS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  // GitHub reaction added to each delivered /bot comment ("" disables).
  const REACTION = process.env.ISSUECHAN_REACTION ?? 'eyes'
  // Reaction that replaces REACTION when the job for a /bot comment is done ("" disables).
  // GitHub has no ✅ reaction, so the default is 🚀.
  const DONE_REACTION = process.env.ISSUECHAN_DONE_REACTION ?? 'rocket'
  // Linear: reactions by emoji name; "done" adds DONE emoji, resolves the thread, or both.
  const LINEAR_REACTION = process.env.ISSUECHAN_LINEAR_REACTION ?? 'eyes'
  const LINEAR_DONE_REACTION = process.env.ISSUECHAN_LINEAR_DONE_REACTION ?? 'white_check_mark'
  const LINEAR_DONE = process.env.ISSUECHAN_LINEAR_DONE ?? 'reaction' // reaction | resolve | both
  const validRef = (repo, issue) => (isGitHub(repo) || isLinear(repo)) && Number.isInteger(issue)
  const REF_ERROR = 'repo must be owner/name (GitHub) or linear:<TEAM> (Linear, e.g. ENG-123 = linear:ENG + issue 123), and issue an integer'
  // GitHub comment ids are numbers; Linear's are UUID strings. Tool calls may pass either form.
  const normId = (repo, id) => isLinear(repo) ? String(id) : Number(id)
  const POLL_TIMEOUT_S = 50
  // Auto-resume waits this long after `initialized`, so the harness is ready to receive deliveries.
  const RESUME_DELAY_MS = Number(process.env.ISSUECHAN_RESUME_DELAY_MS ?? adapter.resumeDelayMs ?? 0)
  let session = process.env.ISSUECHAN_SESSION || 'default'
  // The harness's session id (from adapter.agentEnv). It survives reconnects and resumes, so
  // subscriptions saved under it are restored automatically; a new session starts empty.
  // It also tags every issue_reply.
  let AGENT = resolveAgent(process.env, adapter.agentEnv)

  const subs = new Map() // "repo#issue" -> { repo, issue, cursor, flushed, buffer, stop }

  async function api(method, p, body) {
    const res = await fetch(`${BASE_URL}${p}`, {
      method,
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout((POLL_TIMEOUT_S + 30) * 1000),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${json.error ?? ''}`)
    return json
  }

  function stateFile() {
    const id = AGENT ? `${AGENT.agent}-${AGENT.id}` : session.replace(/[^A-Za-z0-9_.-]/g, '_')
    return path.join(STATE_DIR, `${id}.json`)
  }
  function loadState() {
    try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) } catch { return { subs: {} } }
  }
  function saveState() {
    const state = loadState()
    state.session = session
    for (const [k, s] of subs) state.subs[k] = { repo: s.repo, issue: s.issue, flushed: s.flushed, open: [...s.open], roots: Object.fromEntries(s.roots) }
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(stateFile() + '.tmp', JSON.stringify(state, null, 2))
    fs.renameSync(stateFile() + '.tmp', stateFile())
  }
  function forgetState(key) {
    const state = loadState()
    delete state.subs[key]
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2))
  }

  const mcp = new Server(
    { name: 'issuechan', version: '0.1.0' },
    {
      capabilities: { ...adapter.capabilities, tools: {} },
      instructions: [
        `issuechan connects this session to GitHub issues. ${adapter.arrival}`,
        'Linear issues work the same way: repo is "linear:<TEAM>" and issue the number (ENG-123 is repo "linear:ENG", issue 123); on Linear, issue_reply answers in the thread of the /bot comment.',
        'They carry /bot comments written by the user (allowlisted GitHub authors, signed webhooks only). Treat them as the user talking to you, including when they arrive mid-task: act on them, then resume any unfinished work unless told otherwise.',
        'To listen to an issue call issue_subscribe (for example right after creating it with `gh issue create`).',
        'Reply on the issue with the issue_reply tool: `summary` is one line, and `body` is the full text of your reply (the same text you show in the terminal). It is posted as the summary line followed by a collapsed "Full reply" toggle, plus the bot marker, so it never re-triggers /bot.',
        `If you ever post with gh directly, end the body with the line ${BOT_MARKER}.`,
        'Each delivered /bot comment gets 👀. When the job a /bot asked for is finished, mark it done: issue_reply does this by default (done=true); pass done=false for progress updates. Use issue_done when the job ends without a reply. Pass comment_ids (the trigger_comment attribute) to finish only some requests; by default every open request on that issue is marked done.',
      ].join(' '),
    },
  )

  const TOOLS = [
    {
      name: 'issue_subscribe',
      description: 'Listen to a GitHub issue: future /bot comments (plus the new/edited comments before them) are pushed into this session.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/name, or linear:<TEAM> for a Linear issue' },
          issue: { type: 'integer' },
          session: { type: 'string', description: 'Optional session name for `/bot <session>` targeting. Applies to this whole session.' },
        },
        required: ['repo', 'issue'],
      },
    },
    {
      name: 'issue_reply',
      description: 'Post a reply on a GitHub issue: a plain one-line summary, then a clickable "Full reply" toggle with the full text. Adds the bot marker.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/name, or linear:<TEAM> for a Linear issue' },
          issue: { type: 'integer' },
          summary: { type: 'string', description: 'One-line summary, shown as plain text above the toggle' },
          body: { type: 'string', description: 'Full text of your reply (Markdown)' },
          done: { type: 'boolean', description: 'Mark the /bot request(s) done: 👀 becomes 🚀. Default true; use false for progress updates.' },
          comment_ids: { type: 'array', items: { type: ['integer', 'string'] }, description: 'Trigger comments to mark done (default: all open ones on this issue)' },
          reply_to: { type: ['integer', 'string'], description: 'Linear only: the comment whose thread gets the reply (default: the thread of the newest open /bot request, or of comment_ids[0])' },
        },
        required: ['repo', 'issue', 'summary', 'body'],
      },
    },
    {
      name: 'issue_done',
      description: 'Mark /bot request(s) on an issue as done without replying: replaces 👀 with 🚀. Tolerates deleted comments and missing reactions.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string' },
          issue: { type: 'integer' },
          comment_ids: { type: 'array', items: { type: ['integer', 'string'] }, description: 'Default: all open requests on this issue' },
        },
        required: ['repo', 'issue'],
      },
    },
    {
      name: 'issue_unsubscribe',
      description: 'Stop listening to a GitHub issue.',
      inputSchema: { type: 'object', properties: { repo: { type: 'string' }, issue: { type: 'integer' } }, required: ['repo', 'issue'] },
    },
    {
      name: 'issue_subscriptions',
      description: 'List the issues this session listens to.',
      inputSchema: { type: 'object', properties: {} },
    },
  ]

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const a = req.params.arguments ?? {}
    const text = t => ({ content: [{ type: 'text', text: t }] })
    if (adapter.agentFromCall) {
      const a = adapter.agentFromCall(req.params)
      if (a && !AGENT) {
        AGENT = a
        log(`bound to ${AGENT.agent}:${AGENT.id}`)
        adapter.onBind?.(AGENT, { stateDir: STATE_DIR })
      } else if (a && a.id !== AGENT?.id) log(`tool call from ${a.agent}:${a.id}, but bound to ${AGENT.agent}:${AGENT.id}`)
    }
    try {
      if (req.params.name === 'issue_subscribe') {
        if (!validRef(a.repo, a.issue)) throw new Error(REF_ERROR)
        if (a.session) {
          if (!/^[A-Za-z0-9_.-]+$/.test(a.session)) throw new Error('session must match [A-Za-z0-9_.-]+')
          if (a.session !== session) await renameSession(a.session)
        }
        return text(await subscribe(a.repo, a.issue))
      }
      if (req.params.name === 'issue_reply') {
        if (!validRef(a.repo, a.issue)) throw new Error(REF_ERROR)
        const tag = replyTag({ name: session, agent: AGENT })
        const url = isLinear(a.repo) ? await linearReply(a, tag) : await ghComment(a.repo, a.issue, formatReply({ ...a, tag }))
        if (a.done === false) return text(url)
        return text(`${url}\n${await markDone(a.repo, a.issue, a.comment_ids)}`)
      }
      if (req.params.name === 'issue_done') {
        if (!validRef(a.repo, a.issue)) throw new Error(REF_ERROR)
        return text(await markDone(a.repo, a.issue, a.comment_ids))
      }
      if (req.params.name === 'issue_unsubscribe') {
        const key = `${a.repo}#${a.issue}`
        const s = subs.get(key)
        if (!s) return text(`not subscribed to ${key}`)
        s.stop()
        subs.delete(key)
        forgetState(key)
        await api('DELETE', '/api/subscriptions', { repo: s.repo, issue: s.issue, session }).catch(e => log(e.message))
        return text(`unsubscribed from ${key}`)
      }
      if (req.params.name === 'issue_subscriptions') {
        const list = [...subs.values()].map(s => `${s.repo}#${s.issue} cursor=${s.cursor} pending=${s.buffer.items.size} open_requests=${[...s.open].join(',') || '-'}`)
        return text(`session=${session}\n${list.join('\n') || '(none)'}`)
      }
      throw new Error(`unknown tool ${req.params.name}`)
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: String(e.message ?? e) }] }
    }
  })

  // Move this session's server registrations to a new name (e.g. a forked successor that
  // inherited its parent's name through session-fork handoff), so /bot <old> no longer reaches it.
  let renamed = false
  async function renameSession(name) {
    const old = session
    session = name
    renamed = true
    if (subs.size) saveState()
    for (const s of subs.values()) {
      await api('PUT', '/api/subscriptions', { repo: s.repo, issue: s.issue, session }).catch(e => log(`register ${s.repo}#${s.issue}: ${e.message}`))
      await api('DELETE', '/api/subscriptions', { repo: s.repo, issue: s.issue, session: old }).catch(e => log(`unregister ${old}: ${e.message}`))
    }
  }

  async function subscribe(repo, issue) {
    const key = `${repo}#${issue}`
    if (subs.has(key)) return `already subscribed to ${key} as session ${session}`
    if (!API_KEY) throw new Error(`no API key: set ISSUECHAN_API_KEY or API_KEY in ${ENV_FILE}`)
    let allowed = ALLOWED.length ? ALLOWED : [repo.split('/')[0]]
    if (isLinear(repo)) {
      allowed = linear.allowedAuthors()
      if (!allowed.length) throw new Error(`no Linear allowlist: set LINEAR_ALLOWED_AUTHORS (emails) in ${linear.envFile()} or ISSUECHAN_LINEAR_ALLOWED`)
    }
    const saved = loadState().subs[key]
    // Resume from the last delivered trigger so comments made while this process was down are not lost.
    const start = saved?.flushed ?? (await api('GET', '/api/cursor')).seq
    const s = { repo, issue, cursor: start, flushed: start, buffer: new IssueBuffer({ allowedAuthors: allowed }), stopped: false,
      open: new Set(saved?.open ?? []), roots: new Map(Object.entries(saved?.roots ?? {})), reacting: new Map() }
    s.stop = () => { s.stopped = true }
    if (saved) await replayDelivered(s)
    subs.set(key, s)
    saveState()
    await api('PUT', '/api/subscriptions', { repo, issue, session }).catch(e => log(`register ${key}: ${e.message}`))
    pollLoop(s)
    return `subscribed to ${key} as session "${session}" from cursor ${start}${saved ? ' (resumed)' : ''}; /bot comments from ${allowed.map(a => '@' + a).join(', ')} will be delivered here`
  }

  // Rebuild what the agent already saw (events up to the last delivery) so later edits can be diffed.
  async function replayDelivered(s) {
    let since = 0
    for (;;) {
      const { events } = await api('POST', '/api/events/query', {
        since, limit: 500, filter: { repo: s.repo, issue: s.issue, event: ['issue_comment', 'issues'] },
      })
      for (const ev of events) {
        if (ev.seq > s.flushed) return
        s.buffer.markDelivered(ev)
      }
      if (events.length < 500) return
      since = events.at(-1).seq
    }
  }

  async function pollLoop(s) {
    let backoff = 1000
    let lastHeartbeat = Date.now()
    while (!s.stopped) {
      try {
        const { events, next } = await api('POST', '/api/events/query', {
          since: s.cursor, timeout: POLL_TIMEOUT_S, limit: 200,
          filter: { repo: s.repo, issue: s.issue, event: ['issue_comment', 'issues'] },
        })
        // An unsubscribe can land while this long poll is in flight: drop what it returned.
        if (s.stopped) break
        for (const ev of events) {
          const trig = s.buffer.add(ev)
          if (trig) await maybeDeliver(s, trig)
          if (s.stopped) break
        }
        if (!s.stopped) s.cursor = Math.max(s.cursor, next)
        backoff = 1000
        if (Date.now() - lastHeartbeat > 5 * 60 * 1000) {
          lastHeartbeat = Date.now()
          await api('PUT', '/api/subscriptions', { repo: s.repo, issue: s.issue, session }).catch(() => {})
        }
      } catch (e) {
        if (s.stopped) break
        log(`poll ${s.repo}#${s.issue}: ${e.message}; retry in ${backoff}ms`)
        await new Promise(r => setTimeout(r, backoff))
        backoff = Math.min(backoff * 2, 30000)
      }
    }
  }

  async function maybeDeliver(s, trig) {
    if (s.stopped) return
    let active = []
    if (trig.target && trig.target !== session) {
      const r = await api('GET', `/api/subscriptions?repo=${encodeURIComponent(s.repo)}&issue=${s.issue}`).catch(() => ({ subscriptions: [] }))
      active = r.subscriptions.map(x => x.session)
    }
    if (!isForSession(trig, session, active)) {
      s.buffer.drain() // addressed to another session; its context is theirs
      s.flushed = trig.seq
      saveState()
      return
    }
    // Drain only after the adapter accepted the delivery: if it throws, the poll loop backs off and
    // re-reads the same events, and the /bot is delivered on the next attempt instead of being lost.
    const items = s.buffer.peek()
    await adapter.deliver(mcp, {
      content: formatDelivery({ repo: s.repo, issue: s.issue, title: s.buffer.title, trigger: trig, items }),
      meta: { repo: s.repo, issue: String(s.issue), session, trigger_comment: String(trig.comment_id), seq: String(trig.seq) },
    }, { agent: AGENT })
    s.buffer.drain()
    s.flushed = trig.seq
    s.open.add(trig.comment_id)
    if (isLinear(s.repo)) s.roots.set(String(trig.comment_id), trig.parent_id ?? trig.comment_id)
    saveState()
    log(`delivered ${items.length} item(s) for ${s.repo}#${s.issue} at seq ${trig.seq}`)
    if (isLinear(s.repo)) {
      if (LINEAR_REACTION) {
        s.reacting.set(trig.comment_id, linear.react(trig.comment_id, LINEAR_REACTION)
          .catch(e => { log(`reaction on ${issueLabel(s.repo, s.issue)} comment ${trig.comment_id} failed: ${e.message}`); return null }))
      }
    } else if (REACTION) {
      const p = ghApi(['-X', 'POST', `repos/${s.repo}/issues/comments/${trig.comment_id}/reactions`, '-f', `content=${REACTION}`])
        .then(r => { if (!r.ok) log(`reaction on ${s.repo} comment ${trig.comment_id} failed: ${r.error}`) })
      s.reacting.set(trig.comment_id, p)
    }
  }

  // Replace 👀 with 🚀 on finished /bot requests. Every step tolerates a deleted
  // comment, an already-removed reaction, or an existing done reaction.
  // Linear: reply in the thread of the /bot comment (its root), as Linear threads are one level deep.
  async function linearReply(a, tag) {
    const s = subs.get(`${a.repo}#${a.issue}`)
    const cid = a.reply_to ?? a.comment_ids?.[0] ?? [...(s?.open ?? [])].at(-1)
    const parentId = cid == null ? undefined : (s?.roots.get(String(cid)) ?? String(cid))
    const c = await linear.comment(a.repo, a.issue, formatReply({ ...a, tag, format: 'linear' }), { parentId })
    return c.url
  }

  const GONE = /Entity not found|invalid entity/i
  async function linearMarkDone(s, cid) {
    const notes = []
    let mine = []
    const pending = await s?.reacting.get(cid)
    s?.reacting.delete(cid)
    if (LINEAR_REACTION) {
      if (pending) mine = [pending]
      else {
        const list = await linear.myReactions(cid, LINEAR_REACTION).catch(e => { notes.push(`could not list reactions (${e.message})`); return [] })
        if (list === null) return { gone: true }
        mine = list
        if (!mine.length && !notes.length) notes.push(`no ${LINEAR_REACTION} to remove`)
      }
      // A deleted comment takes its reactions with it ("Entity not found: Reaction").
      for (const id of mine) notes.push(await linear.unreact(id).then(() => `removed ${LINEAR_REACTION}`, e => GONE.test(e.message) ? null : `could not remove ${LINEAR_REACTION} (${e.message})`))
    }
    if (LINEAR_DONE !== 'resolve' && LINEAR_DONE_REACTION) {
      const added = await linear.react(cid, LINEAR_DONE_REACTION).then(() => `added ${LINEAR_DONE_REACTION}`, e => e)
      if (added instanceof Error && GONE.test(added.message)) return { gone: true } // the comment itself is gone
      notes.push(added instanceof Error ? `could not add ${LINEAR_DONE_REACTION} (${added.message})` : added)
    }
    if (LINEAR_DONE === 'resolve' || LINEAR_DONE === 'both') {
      const root = s?.roots.get(String(cid)) ?? cid
      notes.push(await linear.resolveThread(root).then(() => 'resolved the thread', e => `could not resolve the thread (${e.message})`))
    }
    return { notes: notes.filter(Boolean) }
  }

  async function markDone(repo, issue, commentIds) {
    const s = subs.get(`${repo}#${issue}`)
    const ids = (commentIds?.length ? commentIds : [...(s?.open ?? [])]).map(id => normId(repo, id))
    if (!ids.length) return 'no open /bot requests to mark done'
    if (isLinear(repo)) {
      const lines = []
      for (const cid of ids) {
        const res = await linearMarkDone(s, cid)
        s?.open.delete(cid)
        s?.roots.delete(String(cid))
        lines.push(res.gone ? `comment ${cid}: gone (deleted), skipped` : `comment ${cid}: ${res.notes.join(', ')}`)
      }
      if (s) saveState()
      return lines.join('\n')
    }
    const me = await myLogin()
    const lines = []
    for (const cid of ids) {
      await s?.reacting.get(cid)
      s?.reacting.delete(cid)
      const base = `repos/${repo}/issues/comments/${cid}/reactions`
      const notes = []
      if (REACTION && me) {
        const list = await ghApi([`${base}?content=${REACTION}&per_page=100`])
        if (list.status === 404) {
          s?.open.delete(cid)
          lines.push(`comment ${cid}: gone (deleted), skipped`)
          continue
        }
        const mine = list.ok ? (list.json ?? []).filter(r => r.user?.login === me) : []
        if (list.ok && mine.length === 0) notes.push(`no ${REACTION} to remove`)
        for (const r of mine) {
          const del = await ghApi(['-X', 'DELETE', `${base}/${r.id}`])
          notes.push(del.ok || del.status === 404 ? `removed ${REACTION}` : `could not remove ${REACTION} (${del.error})`)
        }
        if (!list.ok) notes.push(`could not list reactions (${list.error})`)
      }
      if (DONE_REACTION) {
        const add = await ghApi(['-X', 'POST', base, '-f', `content=${DONE_REACTION}`])
        if (add.status === 404) {
          s?.open.delete(cid)
          lines.push(`comment ${cid}: gone (deleted), skipped`)
          continue
        }
        notes.push(add.ok ? `added ${DONE_REACTION}` : `could not add ${DONE_REACTION} (${add.error})`)
      }
      s?.open.delete(cid)
      lines.push(`comment ${cid}: ${notes.join(', ')}`)
    }
    if (s) saveState()
    return lines.join('\n')
  }

  const initialized = new Promise(r => { mcp.oninitialized = r })
  await mcp.connect(new StdioServerTransport())
  log(`connected (${adapter.name}); server=${BASE_URL} session=${session} agent=${AGENT ? `${AGENT.agent}:${AGENT.id}` : '-'}`)
  initialized.then(() => new Promise(r => setTimeout(r, RESUME_DELAY_MS))).then(bindAtStart).then(autoResume)

  async function bindAtStart() {
    if (AGENT || !adapter.agentAtStart) return
    const a = await adapter.agentAtStart({ stateDir: STATE_DIR }).catch(e => { log(`bind at start: ${e.message}`); return null })
    if (a && !AGENT) { // a tool call may have bound meanwhile; it wins
      AGENT = a
      log(`bound at start to ${AGENT.agent}:${AGENT.id}`)
    }
  }

  // Restore this agent session's subscriptions (after /mcp reconnect or --resume).
  async function autoResume() {
    if (!AGENT) return
    const state = loadState()
    const saved = Object.values(state.subs ?? {})
    if (!saved.length) return
    if (state.session && !renamed) session = state.session // an explicit issue_subscribe(session) wins
    for (const { repo, issue } of saved) {
      for (let delay = 2000; ; delay = Math.min(delay * 2, 60000)) {
        try { log(await subscribe(repo, issue)); break } catch (e) {
          log(`auto-resume ${repo}#${issue}: ${e.message}; retry in ${delay}ms`)
          await new Promise(r => setTimeout(r, delay))
        }
      }
    }
  }
}
