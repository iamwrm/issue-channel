#!/usr/bin/env node
// issuechan: Claude Code channel (MCP over stdio) that pushes /bot comments from
// subscribed GitHub issues into the running session.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { BOT_MARKER, IssueBuffer, formatDelivery, formatReply, isForSession } from './lib.mjs'

const log = (...a) => console.error('[issuechan]', ...a)

function readEnvFile(file) {
  try {
    return Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n')
      .map(l => l.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]))
  } catch { return {} }
}

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
const POLL_TIMEOUT_S = 50
let session = process.env.ISSUECHAN_SESSION || 'default'
// Claude Code passes its session id to MCP servers. It survives /mcp reconnect and --resume,
// so subscriptions saved under it are restored automatically; a new session starts empty.
const CC_SESSION_ID = /^[A-Za-z0-9-]+$/.test(process.env.CLAUDE_CODE_SESSION_ID ?? '') ? process.env.CLAUDE_CODE_SESSION_ID : null

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
  const id = CC_SESSION_ID ? `cc-${CC_SESSION_ID}` : session.replace(/[^A-Za-z0-9_.-]/g, '_')
  return path.join(STATE_DIR, `${id}.json`)
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) } catch { return { subs: {} } }
}
function saveState() {
  const state = loadState()
  state.session = session
  for (const [k, s] of subs) state.subs[k] = { repo: s.repo, issue: s.issue, flushed: s.flushed, open: [...s.open] }
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
    capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
    instructions: [
      'issuechan connects this session to GitHub issues. Messages arrive as <channel source="issuechan" repo="..." issue="..." ...>.',
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
        repo: { type: 'string', description: 'owner/name' },
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
        repo: { type: 'string', description: 'owner/name' },
        issue: { type: 'integer' },
        summary: { type: 'string', description: 'One-line summary, shown as plain text above the toggle' },
        body: { type: 'string', description: 'Full text of your reply (Markdown)' },
        done: { type: 'boolean', description: 'Mark the /bot request(s) done: 👀 becomes 🚀. Default true; use false for progress updates.' },
        comment_ids: { type: 'array', items: { type: 'integer' }, description: 'Trigger comments to mark done (default: all open ones on this issue)' },
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
        comment_ids: { type: 'array', items: { type: 'integer' }, description: 'Default: all open requests on this issue' },
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
  try {
    if (req.params.name === 'issue_subscribe') {
      if (!/^[\w.-]+\/[\w.-]+$/.test(a.repo ?? '') || !Number.isInteger(a.issue)) throw new Error('repo must be owner/name and issue an integer')
      if (a.session) {
        if (!/^[A-Za-z0-9_.-]+$/.test(a.session)) throw new Error('session must match [A-Za-z0-9_.-]+')
        session = a.session
      }
      return text(await subscribe(a.repo, a.issue))
    }
    if (req.params.name === 'issue_reply') {
      if (!/^[\w.-]+\/[\w.-]+$/.test(a.repo ?? '') || !Number.isInteger(a.issue)) throw new Error('repo must be owner/name and issue an integer')
      const url = await ghComment(a.repo, a.issue, formatReply(a))
      if (a.done === false) return text(url)
      return text(`${url}\n${await markDone(a.repo, a.issue, a.comment_ids)}`)
    }
    if (req.params.name === 'issue_done') {
      if (!/^[\w.-]+\/[\w.-]+$/.test(a.repo ?? '') || !Number.isInteger(a.issue)) throw new Error('repo must be owner/name and issue an integer')
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

async function subscribe(repo, issue) {
  const key = `${repo}#${issue}`
  if (subs.has(key)) return `already subscribed to ${key} as session ${session}`
  if (!API_KEY) throw new Error(`no API key: set ISSUECHAN_API_KEY or API_KEY in ${ENV_FILE}`)
  const allowed = ALLOWED.length ? ALLOWED : [repo.split('/')[0]]
  const saved = loadState().subs[key]
  // Resume from the last delivered trigger so comments made while this process was down are not lost.
  const start = saved?.flushed ?? (await api('GET', '/api/cursor')).seq
  const s = { repo, issue, cursor: start, flushed: start, buffer: new IssueBuffer({ allowedAuthors: allowed }), stopped: false,
    open: new Set(saved?.open ?? []), reacting: new Map() }
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
      for (const ev of events) {
        const trig = s.buffer.add(ev)
        if (trig) await maybeDeliver(s, trig)
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
  const items = s.buffer.drain()
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: formatDelivery({ repo: s.repo, issue: s.issue, title: s.buffer.title, trigger: trig, items }),
      meta: { repo: s.repo, issue: String(s.issue), session, trigger_comment: String(trig.comment_id), seq: String(trig.seq) },
    },
  })
  s.flushed = trig.seq
  s.open.add(trig.comment_id)
  saveState()
  log(`delivered ${items.length} item(s) for ${s.repo}#${s.issue} at seq ${trig.seq}`)
  if (REACTION) {
    const p = ghApi(['-X', 'POST', `repos/${s.repo}/issues/comments/${trig.comment_id}/reactions`, '-f', `content=${REACTION}`])
      .then(r => { if (!r.ok) log(`reaction on ${s.repo} comment ${trig.comment_id} failed: ${r.error}`) })
    s.reacting.set(trig.comment_id, p)
  }
}

function ghComment(repo, issue, body) {
  return new Promise((resolve, reject) => {
    const child = execFile('gh', ['issue', 'comment', String(issue), '-R', repo, '--body-file', '-'], { timeout: 30000 },
      (err, stdout, stderr) => err ? reject(new Error(`gh issue comment failed: ${stderr || err.message}`)) : resolve(stdout.trim()))
    child.stdin.end(body)
  })
}

// Run `gh api`, never throwing: {ok, status, json, error}. status is the HTTP code when gh reports one.
function ghApi(args) {
  return new Promise(resolve => {
    execFile('gh', ['api', ...args], { timeout: 20000 }, (err, stdout, stderr) => {
      if (!err) {
        let json = null
        try { json = stdout.trim() ? JSON.parse(stdout) : null } catch {}
        return resolve({ ok: true, status: 200, json })
      }
      const m = String(stderr).match(/HTTP (\d{3})/)
      resolve({ ok: false, status: m ? Number(m[1]) : 0, error: String(stderr || err.message).trim() })
    })
  })
}

let ghLogin
async function myLogin() {
  if (ghLogin === undefined) {
    const r = await ghApi(['user'])
    ghLogin = r.ok ? r.json.login : null
  }
  return ghLogin
}

// Replace 👀 with 🚀 on finished /bot requests. Every step tolerates a deleted
// comment, an already-removed reaction, or an existing done reaction.
async function markDone(repo, issue, commentIds) {
  const s = subs.get(`${repo}#${issue}`)
  const ids = commentIds?.length ? commentIds : [...(s?.open ?? [])]
  if (!ids.length) return 'no open /bot requests to mark done'
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

await mcp.connect(new StdioServerTransport())
log(`connected; server=${BASE_URL} session=${session} cc_session=${CC_SESSION_ID ?? '-'}`)
autoResume()

// Restore this Claude Code session's subscriptions (after /mcp reconnect or --resume).
async function autoResume() {
  if (!CC_SESSION_ID) return
  const state = loadState()
  const saved = Object.values(state.subs ?? {})
  if (!saved.length) return
  if (state.session) session = state.session
  for (const { repo, issue } of saved) {
    for (let delay = 2000; ; delay = Math.min(delay * 2, 60000)) {
      try { log(await subscribe(repo, issue)); break } catch (e) {
        log(`auto-resume ${repo}#${issue}: ${e.message}; retry in ${delay}ms`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }
}
