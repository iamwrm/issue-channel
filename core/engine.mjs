// Transport-neutral issue-channel runtime. Delivery means durable inbox acceptance,
// not model consumption. This module has no MCP transport or harness dependencies.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IssueBuffer, formatDelivery, formatFooter, formatReply, isForSession, isGitHub, isLinear, issueLabel, replyTag, resolveAgent } from './lib.mjs'
import { ghApi as rawGhApi, ghComment as rawGhComment, myLogin as rawMyLogin } from './github.mjs'
import * as rawLinear from './linear.mjs'

function readEnvFile(file) {
  try {
    return Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n')
      .map(l => l.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]))
  } catch { return {} }
}
const validRef = (repo, issue) => typeof repo === 'string' && (isGitHub(repo) || isLinear(repo)) &&
  repo.split('/').every(part => part !== '.' && part !== '..') && Number.isSafeInteger(issue) && issue > 0
const REF_ERROR = 'repo must be owner/name (GitHub) or linear:<TEAM> (Linear, e.g. ENG-123 = linear:ENG + issue 123), and issue a positive integer'
const validSession = name => typeof name === 'string' && /^[A-Za-z0-9_.-]+$/.test(name)
const validMode = mode => mode === 'bot' || mode === 'updates'
const text = t => ({ content: [{ type: 'text', text: t }] })
const stoppedError = () => new Error('issue engine stopped')

// Races even transports/callbacks that ignore AbortSignal. Always observes late rejection.
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(stoppedError())
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(stoppedError()) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(v => { cleanup(); resolve(v) }, e => { cleanup(); reject(e) })
  })
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(stoppedError())
    const abort = () => { clearTimeout(timer); reject(stoppedError()) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export function createIssueEngine(options = {}) {
  const env = options.env ?? process.env
  const identity = options.agent !== undefined ? options.agent : resolveAgent(env)
  const agent = identity ? { ...identity } : null
  if (agent && (typeof agent.agent !== 'string' || !/^[a-z][a-z0-9]*$/.test(agent.agent) ||
      typeof agent.id !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(agent.id) || agent.id === '.' || agent.id === '..')) throw new Error('invalid agent identity')
  let session = options.session ?? env.ISSUECHAN_SESSION ?? 'default'
  if (!validSession(session)) throw new Error('session must match [A-Za-z0-9_.-]+')
  const explicitSession = options.session !== undefined || !!env.ISSUECHAN_SESSION
  const stateDir = options.stateDir ?? env.ISSUECHAN_STATE_DIR ?? path.join(os.homedir(), '.local/state/issue-channel')
  const ENV_FILE = env.ISSUECHAN_ENV_FILE ?? path.join(os.homedir(), '.local/share/issue-channel/.env')
  const BASE_URL = (env.ISSUECHAN_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
  const API_KEY = env.ISSUECHAN_API_KEY ?? readEnvFile(ENV_FILE).API_KEY
  const ALLOWED = (env.ISSUECHAN_ALLOWED_AUTHORS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const REACTION = env.ISSUECHAN_REACTION ?? 'eyes'
  const DONE_REACTION = env.ISSUECHAN_DONE_REACTION ?? 'rocket'
  const LINEAR_REACTION = env.ISSUECHAN_LINEAR_REACTION ?? 'eyes'
  const LINEAR_DONE_REACTION = env.ISSUECHAN_LINEAR_DONE_REACTION ?? 'white_check_mark'
  const LINEAR_DONE = env.ISSUECHAN_LINEAR_DONE ?? 'reaction'
  const POLL_TIMEOUT_S = 50
  const deliver = options.deliver
  if (typeof deliver !== 'function') throw new Error('deliver callback is required')
  const controller = new AbortController()
  const subs = new Map()
  const registrations = new Map()
  const restoring = new Map()
  const cancelledRestores = new Set()
  const heldDuringReset = new Map() // subscription -> last /bot held back while a no-compact swap runs
  let stopped = false, renamed = false, resetting = false, error, stateError, operationError
  let startPromise, stopPromise, queue = Promise.resolve()
  // Anonymous MCP runtimes use the historical session-named filename.
  let file = path.join(stateDir, `${agent ? `${agent.agent}-${agent.id}` : session}.json`)
  const log = (...args) => { if (!stopped) options.log?.(...args) }
  const check = () => { if (stopped) throw stoppedError(); if (stateError) throw stateError }
  const wait = p => abortable(p, controller.signal).then(v => { check(); return v })
  const ghApi = (...a) => { check(); return wait(rawGhApi(...a)) }
  const ghComment = (...a) => { check(); return wait((options.ghComment ?? rawGhComment)(...a)) } // injectable for tests
  const myLogin = () => { check(); return wait(rawMyLogin()) }
  const linear = Object.fromEntries(Object.entries(rawLinear).map(([k, v]) => [k, typeof v === 'function' ? (...a) => { check(); return wait(v(...a)) } : v]))
  const normId = (repo, id) => isLinear(repo) ? String(id) : Number(id)

  function getStatus() {
    return { session, subscriptions: [...subs.values()].map(s => ({ repo: s.repo, issue: s.issue, mode: s.mode,
      connected: s.connected, cursor: s.cursor, openRequests: [...s.open] })).concat([...restoring.values()].filter(s => !subs.has(`${s.repo}#${s.issue}`)).map(s => ({ ...s, openRequests: [...s.openRequests] }))),
    ...(error ? { error } : {}) }
  }
  function notify() {
    if (stopped) return
    error = stateError?.message ?? [...subs.values()].find(s => s.error)?.error ?? operationError
    try { options.onStatus?.(getStatus()) } catch (e) { log(`status callback: ${e.message}`) }
  }
  function serialize(fn) {
    const result = queue.then(() => { check(); return fn() })
    queue = result.catch(() => {})
    return result
  }
  function loadState() {
    try {
      let state
      try { state = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) {
        if (e.code === 'ENOENT') return { subs: {} }
        throw e
      }
      if (!state || typeof state !== 'object' || Array.isArray(state) || !state.subs || typeof state.subs !== 'object' || Array.isArray(state.subs) ||
          (state.session !== undefined && !validSession(state.session))) throw new Error('invalid state structure')
      for (const [key, s] of Object.entries(state.subs)) {
        if (!s || !validRef(s.repo, s.issue) || key !== `${s.repo}#${s.issue}` ||
            !Number.isSafeInteger(s.flushed) || s.flushed < 0 || (s.mode !== undefined && !validMode(s.mode)) ||
            (s.open !== undefined && (!Array.isArray(s.open) || s.open.some(id => isLinear(s.repo) ? typeof id !== 'string' : !Number.isSafeInteger(id) || id <= 0))) ||
            (s.resetBy !== undefined && typeof s.resetBy !== 'string') ||
            (s.roots !== undefined && (!s.roots || typeof s.roots !== 'object' || Array.isArray(s.roots) || Object.values(s.roots).some(id => typeof id !== 'string')))) throw new Error(`invalid subscription ${key}`)
      }
      return state
    } catch (e) {
      stateError = new Error(`malformed issue-channel state ${file}: ${e.message}`)
      error = stateError.message
      throw stateError
    }
  }
  function saveState(forget) {
    check()
    const state = loadState() // Fail closed even if another process corrupts the file after start.
    state.session = session
    if (forget) delete state.subs[forget]
    for (const [key, s] of subs) state.subs[key] = { repo: s.repo, issue: s.issue, mode: s.mode,
      flushed: s.flushed, open: [...s.open], roots: Object.fromEntries(s.roots), ...(s.resetBy ? { resetBy: s.resetBy } : {}) }
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' })
      fs.renameSync(tmp, file)
    } finally { fs.rmSync(tmp, { force: true }) }
  }
  async function api(method, p, body, signal = controller.signal) {
    const timeout = AbortSignal.timeout((POLL_TIMEOUT_S + 30) * 1000)
    const combined = AbortSignal.any([signal, timeout])
    const res = await abortable(fetch(`${BASE_URL}${p}`, {
      method, headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: combined,
    }), combined)
    const json = await abortable(res.json(), combined).catch(e => { if (combined.aborted) throw e; return {} })
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${json.error ?? ''}`)
    if (signal === controller.signal) check()
    return json
  }
  function registration(s, name = session) { return { repo: s.repo, issue: s.issue, session: name } }
  async function register(s, name = session) {
    const body = registration(s, name)
    registrations.set(JSON.stringify(body), body)
    await api('PUT', '/api/subscriptions', body)
    check()
    s.registered = true
  }
  async function unregister(s, name = session) {
    const body = registration(s, name), key = JSON.stringify(body)
    if (!registrations.has(key)) return
    await api('DELETE', '/api/subscriptions', body)
    registrations.delete(key)
  }
  async function renameSession(name) {
    const old = session
    session = name
    renamed = true
    if (!agent) file = path.join(stateDir, `${session}.json`)
    saveState()
    for (const s of subs.values()) {
      s.connected = false
      try { await register(s); await unregister(s, old); s.error = undefined; s.connected = s.queried }
      catch (e) { check(); s.error = e.message }
    }
    notify()
  }
  async function subscribe(repo, issue, mode) {
    const key = `${repo}#${issue}`
    const current = subs.get(key)
    if (current) {
      if (mode !== undefined && mode !== current.mode) { current.mode = mode; saveState(); notify() }
      return `already subscribed to ${key} as session ${session}; mode=${current.mode} connected=${current.connected}`
    }
    if (!API_KEY) throw new Error(`no API key: set ISSUECHAN_API_KEY or API_KEY in ${ENV_FILE}`)
    let allowed = ALLOWED.length ? ALLOWED : [repo.split('/')[0]]
    if (isLinear(repo)) {
      const linearFile = env.ISSUECHAN_LINEAR_ENV_FILE ?? rawLinear.envFile()
      allowed = (env.ISSUECHAN_LINEAR_ALLOWED ?? readEnvFile(linearFile).LINEAR_ALLOWED_AUTHORS ?? '').split(',').map(s => s.trim()).filter(Boolean)
      if (!allowed.length) throw new Error(`no Linear allowlist: set LINEAR_ALLOWED_AUTHORS (emails) in ${linearFile} or ISSUECHAN_LINEAR_ALLOWED`)
    }
    const saved = loadState().subs[key]
    const from = saved?.flushed ?? (await api('GET', '/api/cursor')).seq
    if (!Number.isSafeInteger(from) || from < 0) throw new Error('invalid server cursor')
    const s = { repo, issue, mode: mode ?? saved?.mode ?? 'bot', cursor: from, flushed: from,
      buffer: new IssueBuffer({ allowedAuthors: allowed }), controller: new AbortController(), connected: false,
      registered: false, queried: false, open: new Set(saved?.open ?? []), roots: new Map(Object.entries(saved?.roots ?? {})), reacting: new Map(), resetBy: saved?.resetBy }
    // Registration failure must not create a durable subscription or report healthy.
    try {
      if (saved) await replayDelivered(s)
      await register(s)
      check()
      subs.set(key, s)
      saveState()
      restoring.delete(key)
      operationError = undefined
    } catch (e) {
      s.controller.abort()
      subs.delete(key)
      await unregister(s).catch(() => {})
      throw e
    }
    notify()
    void pollLoop(s)
    return `subscribed to ${key} as session "${session}" from cursor ${from}${saved ? ' (resumed)' : ''}; ${s.mode === 'updates' ? 'updates' : '/bot comments'} from ${allowed.map(a => '@' + a).join(', ')} will be delivered here; mode=${s.mode} connected=${s.connected}`
  }
  async function replayDelivered(s) {
    let since = 0
    for (;;) {
      const { events } = await api('POST', '/api/events/query', {
        since, limit: 500, filter: { repo: s.repo, issue: s.issue, event: ['issue_comment', 'issues'] },
      })
      if (!Array.isArray(events)) throw new Error('invalid events response')
      for (const ev of events) { if (ev.seq > s.flushed) return; s.buffer.markDelivered(ev) }
      if (events.length < 500) return
      const next = events.at(-1).seq
      if (next <= since) throw new Error('non-advancing replay cursor')
      since = next
    }
  }
  const active = s => !stopped && !stateError && !s.controller.signal.aborted && subs.get(`${s.repo}#${s.issue}`) === s
  async function pollLoop(s) {
    let backoff = 1000, lastHeartbeat = Date.now()
    const signal = AbortSignal.any([controller.signal, s.controller.signal])
    while (active(s)) {
      try {
        if (!s.registered || Date.now() - lastHeartbeat > 5 * 60 * 1000) {
          await serialize(async () => { if (active(s)) await register(s) })
          lastHeartbeat = Date.now()
        }
        const { events, next } = await api('POST', '/api/events/query', {
          since: s.cursor, timeout: s.queried ? POLL_TIMEOUT_S : 0, limit: 200,
          filter: { repo: s.repo, issue: s.issue, event: ['issue_comment', 'issues'] },
        }, signal)
        if (!active(s)) break
        if (!Array.isArray(events) || !Number.isSafeInteger(next) || next < s.cursor || events.some(ev => !Number.isSafeInteger(ev.seq) || ev.seq > next)) throw new Error('invalid events response')
        await serialize(async () => {
          if (!active(s)) return
          s.queried = true
          for (const ev of events) {
            if (!active(s)) return
            if (ev.seq <= s.cursor) continue
            // An unsuccessful delivery must undo *all* mutations of this event,
            // including edit-back no-ops and a trigger already present in the buffer.
            const before = s.buffer.clone()
            try {
              const trig = s.buffer.add(ev)
              const items = s.buffer.peek()
              if (trig || (s.mode === 'updates' && items.some(it => it.seq === ev.seq))) await maybeDeliver(s, trig, ev)
              if (!active(s)) return
              s.cursor = ev.seq
            } catch (e) { if (active(s)) s.buffer = before; throw e }
          }
          if (!active(s)) return
          s.cursor = Math.max(s.cursor, next)
          s.connected = true
          s.error = undefined
          notify()
        })
        backoff = 1000
        // Protect against a misconfigured/non-long-polling server spinning on empty queries.
        if (!events.length) await sleep(25, signal)
      } catch (e) {
        if (!active(s)) break
        s.connected = false
        s.error = e.message
        notify()
        log(`poll ${s.repo}#${s.issue}: ${e.message}; retry in ${backoff}ms`)
        try { await sleep(backoff, signal) } catch { break }
        backoff = Math.min(backoff * 2, 30000)
      }
    }
  }
  async function maybeDeliver(s, trig, ev) {
    if (!active(s)) return
    // A no-compact swap is under way: leave everything after the command unflushed, so the successor, which
    // resumes from the handed-over cursor, gets it instead of this session paying for one more full request.
    if (resetting) { if (trig) heldDuringReset.set(s, { trig, ev }); return }
    if (trig?.command === 'no-compact') {
      // A command is never untargeted by accident: an unknown name means no session, not every session.
      if (trig.target && trig.target !== session) { s.buffer.drain(); s.flushed = ev.seq; saveState(); return }
      if (s.resetBy !== String(trig.comment_id) && await noCompact(s, trig, ev)) return
      // This command already reset the session (this is its successor, resuming from the handed-over cursor), or
      // the reset could not run: from here on it is an ordinary /bot, and without text there is nothing to say.
      s.resetBy = undefined
      if (!trig.text) { s.buffer.drain(); s.flushed = ev.seq; saveState(); return }
    }
    let sessions = []
    if (trig?.target && trig.target !== session) {
      const r = await api('GET', `/api/subscriptions?repo=${encodeURIComponent(s.repo)}&issue=${s.issue}`)
      sessions = r.subscriptions.map(x => x.session)
    }
    if (trig && !isForSession(trig, session, sessions)) {
      s.buffer.drain()
      s.flushed = ev.seq
      saveState()
      return
    }
    const items = s.buffer.peek()
    const meta = { repo: s.repo, issue: String(s.issue), session, seq: String(ev.seq), mode: s.mode, is_request: String(!!trig),
      ...(trig ? { trigger_comment: String(trig.comment_id) } : {}),
      ...(!trig && isLinear(s.repo) && ev.event === 'issue_comment' ? { reply_to: String(ev.parent_id ?? s.roots.get(String(ev.comment_id)) ?? ev.comment_id) } : {}) }
    await wait(deliver({ content: formatDelivery({ repo: s.repo, issue: s.issue, title: s.buffer.title, trigger: trig, items }), meta }))
    if (!active(s)) return
    s.buffer.drain()
    s.flushed = ev.seq
    if (trig) s.open.add(trig.comment_id)
    if (isLinear(s.repo) && ev.event === 'issue_comment') s.roots.set(String(ev.comment_id), ev.parent_id ?? s.roots.get(String(ev.comment_id)) ?? ev.comment_id)
    saveState()
    notify()
    log(`delivered ${items.length} item(s) for ${s.repo}#${s.issue} at seq ${ev.seq}`)
    // Only actual commands create open requests and reactions, even in updates mode.
    if (trig) react(s, trig)
  }

  // `/bot !no-compact [name]`: matched by code, never delivered to this session. The harness adapter swaps the
  // session for a reset fork (onNoCompact). The cursor stays BEFORE the command and `resetBy` marks it, and this
  // state file is handed to the successor: its channel replays the command, sees it was handled, and delivers the
  // text after it (if any) as a normal /bot, so the model gets it as a channel message, not typed or pasted text.
  // Returns false when the swap can't start (then it is delivered here, normally).
  async function noCompact(s, trig, ev) {
    const linearRoot = isLinear(s.repo) ? String(ev.parent_id ?? s.roots.get(String(ev.comment_id)) ?? ev.comment_id) : undefined
    s.resetBy = String(trig.comment_id)
    saveState()
    try {
      if (typeof options.onNoCompact !== 'function') throw new Error('this harness has no no-compact support')
      await wait(Promise.resolve(options.onNoCompact({ repo: s.repo, issue: s.issue, session, agent, comment_id: trig.comment_id,
        reply_to: linearRoot, onFailed: () => swapFailed(s, trig, ev) })))
    } catch (e) {
      if (!active(s)) return true
      log(`no-compact on ${s.repo}#${s.issue}: ${e.message}`)
      const summary = `!no-compact failed: ${e.message}`
      const body = `The session was not reset (${e.message}).${trig.text ? ' The text after the command was delivered to the session as a normal /bot.' : ''}`
      const tag = replyTag({ name: session, agent })
      await (isLinear(s.repo) ? linear.comment(s.repo, s.issue, formatReply({ summary, body, tag, format: 'linear' }), { parentId: linearRoot })
        : ghComment(s.repo, s.issue, formatReply({ summary, body, tag }))).catch(err => log(`no-compact failure reply: ${err.message}`))
      return false
    }
    resetting = true
    notify()
    log(`no-compact on ${s.repo}#${s.issue} at seq ${ev.seq}: swap started`)
    return true
  }
  // The swap process gave up before this session exited (it posts why): listen again. Deliver what was held back
  // meanwhile, or else the command's own text, as a normal /bot.
  function swapFailed(s, trig, ev) {
    if (!resetting || stopped) return
    resetting = false
    log('no-compact swap failed; delivering normally again')
    const held = new Map(heldDuringReset)
    heldDuringReset.clear()
    if (!held.has(s)) held.set(s, { trig, ev })
    for (const [sub, h] of held) serialize(() => active(sub) ? maybeDeliver(sub, h.trig, h.ev) : undefined).catch(e => log(`redeliver after failed no-compact: ${e.message}`))
  }
  function react(s, trig) {
    if (isLinear(s.repo)) {
      if (LINEAR_REACTION) s.reacting.set(trig.comment_id, linear.react(trig.comment_id, LINEAR_REACTION).catch(e => { log(`reaction on ${issueLabel(s.repo, s.issue)} comment ${trig.comment_id} failed: ${e.message}`); return null }))
    } else if (REACTION) {
      s.reacting.set(trig.comment_id, ghApi(['-X', 'POST', `repos/${s.repo}/issues/comments/${trig.comment_id}/reactions`, '-f', `content=${REACTION}`])
        .then(r => { if (!r.ok) log(`reaction on ${s.repo} comment ${trig.comment_id} failed: ${r.error}`) }).catch(e => log(e.message)))
    }
  }

  async function callTool(name, args = {}) {
    try {
      await start()
      const result = await serialize(async () => {
        const a = args ?? {}
        if (name !== 'issue_subscriptions' && !ISSUE_TOOLS.some(t => t.name === name)) throw new Error(`unknown tool ${name}`)
        if (name !== 'issue_subscriptions' && !validRef(a.repo, a.issue)) throw new Error(REF_ERROR)
        if (a.comment_ids !== undefined && (!Array.isArray(a.comment_ids) || a.comment_ids.some(id => isLinear(a.repo) ? typeof id !== 'string' || !id : !Number.isSafeInteger(Number(id)) || Number(id) <= 0))) throw new Error('invalid comment_ids')
        if (name === 'issue_subscribe') {
          if (a.mode !== undefined && !validMode(a.mode)) throw new Error('mode must be bot or updates')
          if (a.session !== undefined) {
            if (!validSession(a.session)) throw new Error('session must match [A-Za-z0-9_.-]+')
            if (a.session !== session) await renameSession(a.session)
          }
          return text(await subscribe(a.repo, a.issue, a.mode))
        }
        if (name === 'issue_reply') {
          const tag = replyTag({ name: session, agent })
          // Validate the reply before any external side effect.
          formatReply({ ...a, tag })
          const reply = { ...a, tag, footer: await replyFooter() }
          const url = isLinear(a.repo) ? await linearReply(reply) : await ghComment(a.repo, a.issue, formatReply(reply))
          return text(a.done === false ? url : `${url}\n${await markDone(a.repo, a.issue, a.comment_ids)}`)
        }
        if (name === 'issue_done') return text(await markDone(a.repo, a.issue, a.comment_ids))
        if (name === 'issue_unsubscribe') {
          const key = `${a.repo}#${a.issue}`, s = subs.get(key)
          if (!s && !restoring.has(key)) return text(`not subscribed to ${key}`)
          cancelledRestores.add(key)
          restoring.delete(key)
          s?.controller.abort()
          subs.delete(key)
          saveState(key)
          notify()
          if (s) await unregister(s).catch(e => log(e.message))
          return text(`unsubscribed from ${key}`)
        }
        const list = [...subs.values()].map(s => `${s.repo}#${s.issue} cursor=${s.cursor} mode=${s.mode} connected=${s.connected} pending=${s.buffer.items.size} open_requests=${[...s.open].join(',') || '-'}`)
        const pending = [...restoring.values()].map(s => `${s.repo}#${s.issue} cursor=${s.cursor} mode=${s.mode} connected=false (restoring)`)
        return text(`session=${session}\n${[...list, ...pending].join('\n') || '(none)'}`)
      })
      if (!stopped) { operationError = undefined; notify() }
      return result
    } catch (e) { if (!stopped) { operationError = e.message; notify() }; return { isError: true, ...text(String(e.message ?? e)) } }
  }
  function start() {
    if (stopped) return Promise.reject(stoppedError())
    if (startPromise) return startPromise
    startPromise = Promise.resolve().then(() => {
      check()
      const state = loadState()
      if (state.session && !explicitSession && !renamed) session = state.session
      if (agent) for (const [key, s] of Object.entries(state.subs)) restoring.set(key, {
        repo: s.repo, issue: s.issue, mode: s.mode ?? 'bot', connected: false, cursor: s.flushed, openRequests: [...(s.open ?? [])],
      })
      notify()
      if (agent) void autoResume(Object.values(state.subs))
    }).catch(e => { if (!stopped) { error = e.message; notify() }; throw e })
    return startPromise
  }
  async function autoResume(saved) {
    for (const { repo, issue, mode } of saved) {
      for (let delay = 2000; !stopped; delay = Math.min(delay * 2, 60000)) {
        if (cancelledRestores.has(`${repo}#${issue}`) || subs.has(`${repo}#${issue}`)) break
        try {
          await serialize(() => cancelledRestores.has(`${repo}#${issue}`) || subs.has(`${repo}#${issue}`) ? undefined : subscribe(repo, issue, mode))
          break
        }
        catch (e) {
          if (stopped || stateError) return
          operationError = e.message
          notify()
          log(`auto-resume ${repo}#${issue}: ${e.message}; retry in ${delay}ms`)
          try { await sleep(delay, controller.signal) } catch { return }
        }
      }
    }
  }
  function stop() {
    if (stopPromise) return stopPromise
    stopped = true
    controller.abort()
    for (const s of subs.values()) { s.controller.abort(); s.connected = false }
    for (const s of restoring.values()) s.connected = false
    // Do not await poll tasks, adapters, or a hung network. Forget no durable state.
    stopPromise = Promise.allSettled([...registrations.values()].map(body =>
      api('DELETE', '/api/subscriptions', body, AbortSignal.timeout(500)))).then(() => { registrations.clear() })
    return stopPromise
  }

  // Reply/done helpers intentionally retain the existing GitHub/Linear semantics.
  // The adapter's model/context stats for the reply footer. Best effort: a failure only drops the footer.
  async function replyFooter() {
    if (!options.replyFooter) return ''
    try { return formatFooter({ agent: agent?.agent, ...await options.replyFooter() }) }
    catch (err) { log(`reply footer: ${err.message}`); return '' }
  }

  async function linearReply(a) {
    const s = subs.get(`${a.repo}#${a.issue}`)
    const cid = a.reply_to ?? a.comment_ids?.[0] ?? [...(s?.open ?? [])].at(-1)
    const parentId = cid == null ? undefined : (s?.roots.get(String(cid)) ?? String(cid))
    const c = await linear.comment(a.repo, a.issue, formatReply({ ...a, format: 'linear' }), { parentId })
    return c.url
  }

  const GONE = /Entity not found|invalid entity/i
  async function linearMarkDone(s, cid) {
    const notes = []
    let mine = []
    const pending = await wait(s?.reacting.get(cid))
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
        check()
        s?.open.delete(cid)
        s?.roots.delete(String(cid))
        if (s) saveState()
        notify()
        lines.push(res.gone ? `comment ${cid}: gone (deleted), skipped` : `comment ${cid}: ${res.notes.join(', ')}`)
      }
      if (s) saveState()
      return lines.join('\n')
    }
    const me = REACTION ? await myLogin() : null
    const lines = []
    for (const cid of ids) {
      await wait(s?.reacting.get(cid))
      s?.reacting.delete(cid)
      const base = `repos/${repo}/issues/comments/${cid}/reactions`
      const notes = []
      if (REACTION && me) {
        const list = await ghApi([`${base}?content=${REACTION}&per_page=100`])
        if (list.status === 404) {
          s?.open.delete(cid)
          if (s) saveState()
          notify()
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
          if (s) saveState()
          notify()
          lines.push(`comment ${cid}: gone (deleted), skipped`)
          continue
        }
        notes.push(add.ok ? `added ${DONE_REACTION}` : `could not add ${DONE_REACTION} (${add.error})`)
      }
      s?.open.delete(cid)
      if (s) saveState()
      notify()
      lines.push(`comment ${cid}: ${notes.join(', ')}`)
    }
    if (s) saveState()
    return lines.join('\n')
  }

  return { start, stop, callTool, getStatus }
}

// Schemas are shared by MCP and native clients.
export const ISSUE_TOOLS = [
    {
      name: 'issue_subscribe',
      description: 'Listen to a GitHub issue: future /bot comments (plus the new/edited comments before them) are pushed into this session.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/name, or linear:<TEAM> for a Linear issue' },
          issue: { type: 'integer' },
          mode: { type: 'string', enum: ['bot', 'updates'], description: 'Default bot: wait for /bot. Updates: deliver accepted comments and issue changes immediately.' },
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
