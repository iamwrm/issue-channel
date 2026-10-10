#!/usr/bin/env node
// issue-channel server: GitHub webhook receiver + SQLite event log + long-poll API.
// Dependency-free (Node >= 24, node:sqlite).
import { pathToFileURL } from 'node:url'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MAX_BODY = 5 * 1024 * 1024
// Cloudflare closes proxied requests that send no response for ~100s, so cap waits below that.
const MAX_WAIT_S = 90
const MAX_LIMIT = 500
// A copy sent to a peer carries its hop count and a peer signature over (delivery, event, hop, body), so
// the hop count and delivery id can't be forged by someone who only replays a GitHub request.
// Loops end because a server forwards a delivery only the first time it stores it; MAX_HOPS is a second stop.
const HOP_HEADER = 'x-issue-channel-hop'
const PEER_SIG_HEADER = 'x-issue-channel-signature'
export const MAX_HOPS = 4
const FORWARD_HEADERS = ['content-type', 'user-agent', 'x-github-event', 'x-github-delivery', 'x-github-hook-id',
  'x-github-hook-installation-target-id', 'x-github-hook-installation-target-type', 'x-hub-signature', 'x-hub-signature-256',
  'linear-delivery', 'linear-event', 'linear-signature', 'linear-timestamp']
// Linear asks receivers to reject a webhook whose webhookTimestamp is older than a minute (replay guard).
const LINEAR_MAX_SKEW_MS = 60 * 1000
// Webhook sources: where the delivery id, event name and signature live. A copy to a peer goes to the same path.
const SOURCES = {
  github: { path: '/webhook/github', delivery: 'x-github-delivery', event: 'x-github-event' },
  linear: { path: '/webhook/linear', delivery: 'linear-delivery', event: 'linear-event' },
}
const PEER_TIMEOUT_MS = 10000
// Copies to a peer go through a durable outbox, one peer at a time and in order. Backoff is per peer
// (it measures the peer's connectivity, not one message): base * 2^(failures-1), capped, with jitter.
// After maxAttempts failures in a row the peer is parked: its copies stay queued (up to maxAgeMs / maxRows)
// and it is tried again when it re-joins (PUT /api/peers), when a new webhook arrives, or at server start.
export const DEFAULT_RETRY = { baseMs: 2000, maxMs: 10 * 60 * 1000, maxAttempts: 12, jitter: 0.2, maxAgeMs: 7 * 24 * 3600 * 1000, maxRows: 10000 }
const PEER_SUBS_TIMEOUT_MS = 3000

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id TEXT NOT NULL UNIQUE,
      event TEXT NOT NULL,
      action TEXT,
      repo TEXT,
      issue INTEGER,
      comment_id INTEGER,
      author TEXT,
      title TEXT,
      body TEXT,
      created_at TEXT,
      updated_at TEXT,
      received_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_repo_issue ON events (repo, issue, seq);
    CREATE INDEX IF NOT EXISTS events_event ON events (event, action);
    CREATE TABLE IF NOT EXISTS subscriptions (
      repo TEXT NOT NULL,
      issue INTEGER NOT NULL,
      session TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (repo, issue, session)
    );
    CREATE TABLE IF NOT EXISTS peers (
      name TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_at TEXT,
      last_status TEXT,
      fail_count INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS outbox (
      peer TEXT NOT NULL,
      seq INTEGER NOT NULL,
      hop INTEGER NOT NULL,
      headers TEXT NOT NULL,
      queued_at INTEGER NOT NULL,
      PRIMARY KEY (peer, seq)
    );
  `)
  // Columns added after the first release (Linear threads and app authors).
  const eventCols = db.prepare('PRAGMA table_info(events)').all().map(c => c.name)
  for (const c of ['parent_id', 'bot_actor']) if (!eventCols.includes(c)) db.exec(`ALTER TABLE events ADD COLUMN ${c} TEXT`)
  // peers tables from an earlier build of this branch: add the backoff columns.
  const peerCols = db.prepare('PRAGMA table_info(peers)').all().map(c => c.name)
  if (!peerCols.includes('fail_count')) db.exec('ALTER TABLE peers ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0')
  if (!peerCols.includes('next_at')) db.exec('ALTER TABLE peers ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0')
  db.function('regexp', { deterministic: true }, (pattern, value) => {
    if (value == null) return 0
    return new RegExp(pattern).test(value) ? 1 : 0
  })
  return db
}

export function extract(event, payload) {
  const issue = payload.issue ?? payload.pull_request ?? null
  const comment = payload.comment ?? null
  return {
    event,
    action: payload.action ?? null,
    repo: payload.repository?.full_name ?? null,
    issue: issue?.number ?? null,
    comment_id: comment?.id ?? null,
    author: comment?.user?.login ?? payload.sender?.login ?? null,
    title: issue?.title ?? null,
    body: comment ? (comment.body ?? null) : (issue?.body ?? null),
    created_at: (comment ?? issue)?.created_at ?? null,
    updated_at: (comment ?? issue)?.updated_at ?? null,
  }
}

// Linear: a Comment or Issue webhook mapped onto the GitHub-shaped event model, so the core treats both alike.
// The issue ref is repo "linear:<TEAM>" + the issue number, e.g. ENG-123 -> ("linear:ENG", 123).
const LINEAR_ACTIONS = { Comment: { create: 'created', update: 'edited', remove: 'deleted' }, Issue: { create: 'opened', update: 'edited', remove: 'deleted' } }
export function extractLinear(type, payload) {
  const d = payload.data ?? {}
  const ref = id => { const m = String(id ?? '').match(/^([A-Za-z0-9]+)-(\d+)$/); return m ? { repo: `linear:${m[1].toUpperCase()}`, issue: Number(m[2]) } : { repo: null, issue: null } }
  const actorOf = u => u?.email ?? (u?.name ? `app:${u.name}` : null)
  const map = LINEAR_ACTIONS[type]
  let action = map?.[payload.action] ?? payload.action ?? null
  // An update that doesn't touch the text (reactions, resolving, moving) is not an edit for the agent.
  const from = payload.updatedFrom ?? {}
  if (payload.action === 'update' && type === 'Comment' && !('body' in from)) action = 'updated'
  if (payload.action === 'update' && type === 'Issue' && !('description' in from) && !('title' in from)) action = 'updated'
  if (type === 'Comment') {
    // Comments posted with an OAuth app token (actor=app) come from the app's user, whose email is
    // <uuid>@oauthapp.linear.app; botActor stays null for them (seen live), so the email marks them too.
    const appUser = /@oauthapp\.linear\.app$/i.test(d.user?.email ?? '') ? JSON.stringify({ app: d.user.name ?? null, id: d.user.id ?? null }) : null
    return {
      event: 'issue_comment', action, ...ref(d.issue?.identifier), comment_id: d.id ?? null,
      author: d.botActor ? `app:${(typeof d.botActor === 'object' ? d.botActor.name : null) ?? 'bot'}` : (d.user?.email ?? actorOf(payload.actor)),
      title: d.issue?.title ?? null, body: d.body ?? null, created_at: d.createdAt ?? null, updated_at: d.updatedAt ?? null,
      parent_id: d.parentId ?? null, bot_actor: d.botActor ? (typeof d.botActor === 'string' ? d.botActor : JSON.stringify(d.botActor)) : appUser,
    }
  }
  if (type === 'Issue') {
    return {
      event: 'issues', action, ...ref(d.identifier ?? (d.team?.key && d.number != null ? `${d.team.key}-${d.number}` : null)), comment_id: null,
      author: actorOf(payload.actor), title: d.title ?? null, body: d.description ?? null, created_at: d.createdAt ?? null, updated_at: d.updatedAt ?? null,
      parent_id: null, bot_actor: payload.actor?.type === 'oauthClient' || payload.actor?.type === 'app' || /@oauthapp\.linear\.app$/i.test(payload.actor?.email ?? '')
        ? JSON.stringify({ app: payload.actor.name ?? null, id: payload.actor.id ?? null }) : null,
    }
  }
  return { event: `linear:${type}`, action, repo: null, issue: null, comment_id: d.id ?? null, author: actorOf(payload.actor), title: null, body: null,
    created_at: d.createdAt ?? null, updated_at: d.updatedAt ?? null, parent_id: null, bot_actor: null }
}

export function verifyLinearSignature(secret, raw, header) {
  if (typeof header !== 'string' || !/^[0-9a-f]{64}$/i.test(header)) return false
  const want = Buffer.from(crypto.createHmac('sha256', secret).update(raw).digest('hex'))
  const got = Buffer.from(header.toLowerCase())
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

export function verifySignature(secret, raw, header) {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false
  const want = Buffer.from('sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex'))
  const got = Buffer.from(header)
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

const TEXT_FIELDS = ['title', 'body']
const LIST_FIELDS = ['event', 'action', 'author']

// Compile a structured filter into a parameterized WHERE clause. Never accepts raw SQL.
export function compileFilter(filter = {}) {
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) throw new HttpError(400, 'filter must be an object')
  const where = []
  const params = []
  for (const key of Object.keys(filter)) {
    if (![...TEXT_FIELDS, ...LIST_FIELDS, 'repo', 'issue', 'exclude_body_contains'].includes(key)) {
      throw new HttpError(400, `unknown filter key: ${key}`)
    }
  }
  if (filter.repo != null) { where.push('repo = ?'); params.push(String(filter.repo)) }
  if (filter.issue != null) {
    const n = Number(filter.issue)
    if (!Number.isInteger(n)) throw new HttpError(400, 'issue must be an integer')
    where.push('issue = ?'); params.push(n)
  }
  for (const key of LIST_FIELDS) {
    if (filter[key] == null) continue
    const values = (Array.isArray(filter[key]) ? filter[key] : [filter[key]]).map(String)
    if (values.length === 0) throw new HttpError(400, `${key} must not be empty`)
    where.push(`${key} IN (${values.map(() => '?').join(', ')})`)
    params.push(...values)
  }
  for (const key of TEXT_FIELDS) {
    const m = filter[key]
    if (m == null) continue
    const ops = typeof m === 'object' ? Object.keys(m) : []
    if (ops.length !== 1 || !['contains', 'like', 'regex'].includes(ops[0])) {
      throw new HttpError(400, `${key} matcher must be exactly one of {contains|like|regex}`)
    }
    const v = String(m[ops[0]])
    if (ops[0] === 'contains') { where.push(`instr(${key}, ?) > 0`); params.push(v) }
    if (ops[0] === 'like') { where.push(`${key} LIKE ?`); params.push(v) }
    if (ops[0] === 'regex') {
      try { new RegExp(v) } catch { throw new HttpError(400, `invalid regex for ${key}`) }
      where.push(`${key} REGEXP ?`); params.push(v)
    }
  }
  if (filter.exclude_body_contains != null) {
    where.push('(body IS NULL OR instr(body, ?) = 0)'); params.push(String(filter.exclude_body_contains))
  }
  return { where, params }
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

const SUMMARY_COLS = 'seq, delivery_id, event, action, repo, issue, comment_id, author, title, body, created_at, updated_at, received_at, parent_id, bot_actor'

export function peerSignature(secret, { delivery, event, hop }, raw) {
  const h = crypto.createHmac('sha256', secret).update(`issue-channel-peer\n${delivery}\n${event}\n${hop}\n`).update(raw)
  return 'sha256=' + h.digest('hex')
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

export function normalizePeerUrl(u) {
  let url
  try { url = new URL(String(u)) } catch { throw new HttpError(400, 'url must be an absolute http(s) URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash) throw new HttpError(400, 'url must be an absolute http(s) URL without query')
  return url.origin + url.pathname.replace(/\/+$/, '')
}

export function backoffMs(failures, { baseMs, maxMs, jitter }, rand = Math.random) {
  const ms = Math.min(maxMs, baseMs * 2 ** Math.max(failures - 1, 0))
  return Math.round(ms * (1 + jitter * (2 * rand() - 1)))
}

export function createApp({ db, webhookSecret, apiKey, linearSecret = null, now = () => new Date().toISOString(), log = console.error,
  fetch = globalThis.fetch, retry = {}, clock = Date.now }) {
  retry = { ...DEFAULT_RETRY, ...retry }
  if (!webhookSecret || !apiKey) throw new Error('webhookSecret and apiKey are required')
  const waiters = new Set()
  const insert = db.prepare(`
    INSERT INTO events (delivery_id, event, action, repo, issue, comment_id, author, title, body, created_at, updated_at, received_at, payload, parent_id, bot_actor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (delivery_id) DO NOTHING`)
  const apiKeyBuf = Buffer.from(`Bearer ${apiKey}`)

  function authorized(req) {
    const got = Buffer.from(req.headers.authorization ?? '')
    return got.length === apiKeyBuf.length && crypto.timingSafeEqual(got, apiKeyBuf)
  }

  function queryEvents({ since = 0, limit = 100, filter = {}, include_payload = false }) {
    const { where, params } = compileFilter(filter)
    where.unshift('seq > ?'); params.unshift(Number(since) || 0)
    const n = Math.min(Math.max(Number(limit) || 100, 1), MAX_LIMIT)
    const cols = include_payload ? `${SUMMARY_COLS}, payload` : SUMMARY_COLS
    const rows = db.prepare(`SELECT ${cols} FROM events WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`).all(...params, n)
    if (include_payload) for (const r of rows) r.payload = JSON.parse(r.payload)
    return rows
  }

  const listPeers = () => db.prepare(`SELECT p.name, p.url, p.updated_at, p.last_at, p.last_status, p.fail_count, p.next_at,
      (SELECT COUNT(*) FROM outbox o WHERE o.peer = p.name) AS pending FROM peers p ORDER BY p.name`).all()
    .map(p => ({ ...p, parked: p.fail_count >= retry.maxAttempts, next_at: p.next_at ? new Date(p.next_at).toISOString() : null }))
  const getPeer = db.prepare('SELECT name, url, fail_count, next_at FROM peers WHERE name = ?')
  const setPeerState = db.prepare('UPDATE peers SET last_at = ?, last_status = ?, fail_count = ?, next_at = ? WHERE name = ?')
  const enqueue = db.prepare('INSERT OR IGNORE INTO outbox (peer, seq, hop, headers, queued_at) VALUES (?, ?, ?, ?, ?)')
  const headOf = db.prepare(`SELECT o.seq, o.hop, o.headers, e.payload FROM outbox o JOIN events e ON e.seq = o.seq
    WHERE o.peer = ? ORDER BY o.seq LIMIT 1`)
  const dequeue = db.prepare('DELETE FROM outbox WHERE peer = ? AND seq = ?')
  const pruneAge = db.prepare('DELETE FROM outbox WHERE peer = ? AND queued_at < ?')
  const pruneRows = db.prepare('DELETE FROM outbox WHERE peer = ? AND seq NOT IN (SELECT seq FROM outbox WHERE peer = ? ORDER BY seq DESC LIMIT ?)')
  const draining = new Map() // peer -> { again: boolean, probe: boolean } while a drain runs
  const timers = new Map()

  function schedule(name, at) {
    clearTimeout(timers.get(name))
    const t = setTimeout(() => { timers.delete(name); kick(name) }, Math.max(at - Date.now(), 0))
    t.unref?.()
    timers.set(name, t)
  }

  // Start (or re-run) the drain of one peer's outbox. probe: try now even if parked or backing off.
  function kick(name, { probe = false } = {}) {
    const d = draining.get(name)
    if (d) { d.again = true; d.probe ||= probe; return }
    drain(name, probe).catch(err => log(`outbox ${name}: ${err.stack ?? err.message}`))
  }

  async function sendOnce(peer, row) {
    const raw = Buffer.from(row.payload, 'utf8')
    const h = JSON.parse(row.headers)
    const src = SOURCES[h[':source']] ?? SOURCES.github
    delete h[':source']
    const delivery = h[src.delivery]
    h[HOP_HEADER] = String(row.hop)
    h[PEER_SIG_HEADER] = peerSignature(webhookSecret, { delivery, event: h[src.event], hop: row.hop }, raw)
    try {
      const r = await fetch(`${peer.url}${src.path}`, { method: 'POST', headers: h, body: raw, signal: AbortSignal.timeout(PEER_TIMEOUT_MS) })
      await r.arrayBuffer().catch(() => {})
      // 2xx: delivered (200 = the peer already had it). 4xx: the peer rejects it (bad signature, ...), and
      // retrying won't help, so drop it. Anything else is a connectivity problem: back off.
      return { status: String(r.status), done: r.status < 500, delivery }
    } catch (e) {
      return { status: `error: ${e.cause?.code ?? e.name ?? e.message}`, done: false, delivery }
    }
  }

  async function drain(name, probe) {
    const state = { again: false, probe: false }
    draining.set(name, state)
    try {
      for (;;) {
        const peer = getPeer.get(name)
        if (!peer) return
        const parked = peer.fail_count >= retry.maxAttempts
        if (!probe && parked) return
        if (!probe && peer.next_at > Date.now()) return schedule(name, peer.next_at)
        const row = headOf.get(name)
        if (!row) return
        const res = await sendOnce(peer, row)
        if (getPeer.get(name)?.url !== peer.url) continue // removed or re-joined meanwhile: start over
        if (res.done) {
          dequeue.run(name, row.seq)
          setPeerState.run(now(), res.status, 0, 0, name)
          log(`forward delivery=${res.delivery} -> ${name} ${res.status}`)
          probe = false
          continue
        }
        const failures = peer.fail_count + 1
        const nextAt = failures >= retry.maxAttempts ? 0 : Date.now() + backoffMs(failures, retry)
        setPeerState.run(now(), res.status, failures, nextAt, name)
        log(`forward delivery=${res.delivery} -> ${name} ${res.status} (failure ${failures}/${retry.maxAttempts}${nextAt ? `, retry in ${Math.round((nextAt - Date.now()) / 1000)}s` : ', parked until it re-joins or a new webhook arrives'})`)
        if (nextAt) schedule(name, nextAt)
        return
      }
    } finally {
      draining.delete(name)
      if (state.again) kick(name, { probe: state.probe })
    }
  }

  // Queue a stored webhook for every peer (durable), then send.
  function replicate(seq, headers, hop, source) {
    const h = { ':source': source }
    for (const k of FORWARD_HEADERS) if (headers[k] != null) h[k] = String(headers[k])
    const json = JSON.stringify(h), t = Date.now()
    for (const peer of db.prepare('SELECT name, fail_count FROM peers').all()) {
      enqueue.run(peer.name, seq, hop, json, t)
      const dropped = pruneAge.run(peer.name, t - retry.maxAgeMs).changes + pruneRows.run(peer.name, peer.name, retry.maxRows).changes
      if (dropped) log(`outbox ${peer.name}: dropped ${dropped} old copies (max age ${retry.maxAgeMs / 3600000}h, max ${retry.maxRows})`)
      kick(peer.name, { probe: peer.fail_count >= retry.maxAttempts })
    }
  }

  // Subscriptions of the peers, so `/bot <name>` counts a session listening on another box as a target.
  // depth 2 reaches the peers of the peers, which covers a primary with several joined boxes from any box.
  async function peerSubscriptions(query, depth) {
    if (depth <= 0) return []
    const lists = await Promise.all(listPeers().map(async peer => {
      try {
        const q = new URLSearchParams(query); q.set('depth', String(depth - 1))
        const r = await fetch(`${peer.url}/api/subscriptions?${q}`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(PEER_SUBS_TIMEOUT_MS) })
        if (!r.ok) return []
        return (await r.json()).subscriptions ?? []
      } catch { return [] }
    }))
    return lists.flat()
  }

  function maxSeq() {
    return db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get().seq
  }

  async function longPoll(req, res, q) {
    const timeout = Math.min(Math.max(Number(q.timeout) || 0, 0), MAX_WAIT_S)
    const deadline = Date.now() + timeout * 1000
    let closed = false
    res.on('close', () => { closed = true })
    for (;;) {
      const events = queryEvents(q)
      const remaining = deadline - Date.now()
      if (events.length || remaining <= 0 || closed) {
        // When nothing matched, still advance the cursor past non-matching rows.
        const next = events.length ? events.at(-1).seq : Math.max(Number(q.since) || 0, maxSeq())
        return send(res, 200, { events, next })
      }
      await new Promise(resolve => {
        const w = () => { clearTimeout(t); waiters.delete(w); resolve() }
        const t = setTimeout(w, remaining)
        waiters.add(w)
        res.once('close', w)
      })
    }
  }

  async function webhook(req, res, source) {
    const src = SOURCES[source]
    const raw = await readBody(req)
    const ok = source === 'linear'
      ? verifyLinearSignature(linearSecret, raw, req.headers['linear-signature'])
      : verifySignature(webhookSecret, raw, req.headers['x-hub-signature-256'])
    if (!ok) throw new HttpError(401, 'bad signature')
    const delivery = req.headers[src.delivery]
    const event = req.headers[src.event]
    if (!delivery || !event) throw new HttpError(400, `missing ${source} headers`)
    // A copy from a peer must also prove that its hop count and delivery id come from a peer.
    let hop = 0
    if (req.headers[HOP_HEADER] != null) {
      hop = Number(req.headers[HOP_HEADER])
      if (!Number.isInteger(hop) || hop < 1 || hop > MAX_HOPS) throw new HttpError(400, 'bad hop count')
      if (!safeEqual(req.headers[PEER_SIG_HEADER], peerSignature(webhookSecret, { delivery, event, hop }, raw))) {
        throw new HttpError(401, 'bad peer signature')
      }
    }
    let payload
    try { payload = JSON.parse(raw.toString('utf8')) } catch { throw new HttpError(400, 'payload must be JSON') }
    // Linear's replay guard applies to first-hand deliveries; a peer's copy may be minutes old (outbox retries)
    // and is covered by the peer signature and dedupe instead.
    if (source === 'linear' && hop === 0 && !(Math.abs(clock() - Number(payload.webhookTimestamp)) <= LINEAR_MAX_SKEW_MS)) {
      throw new HttpError(401, 'stale or missing webhookTimestamp')
    }
    const e = source === 'linear' ? extractLinear(String(event), payload) : extract(String(event), payload)
    const r = insert.run(String(delivery), e.event, e.action, e.repo, e.issue, e.comment_id, e.author, e.title, e.body,
      e.created_at, e.updated_at, now(), raw.toString('utf8'), e.parent_id ?? null, e.bot_actor ?? null)
    const stored = r.changes > 0
    if (stored) for (const w of [...waiters]) w()
    log(`webhook ${source === 'linear' ? 'linear:' : ''}${event}.${e.action ?? '-'} ${e.repo ?? '-'}#${e.issue ?? '-'} delivery=${delivery} ${stored ? 'stored' : 'duplicate'}${hop ? ` (forwarded, hop ${hop})` : ''}`)
    // Relay on: a box's own webhook reaches the primary and through it the other boxes. Each server
    // forwards a delivery once (only when it is new here), so the flood ends; the sender just answers 200.
    if (stored && hop < MAX_HOPS) replicate(Number(r.lastInsertRowid), req.headers, hop + 1, source)
    // Linear counts anything but 200 as a failed delivery.
    return send(res, stored && source === 'github' ? 201 : 200, { stored, duplicate: !stored })
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x')
    const route = `${req.method} ${url.pathname}`

    if (route === 'GET /healthz') return send(res, 200, { ok: true })

    if (route === 'POST /webhook/github') return webhook(req, res, 'github')
    if (route === 'POST /webhook/linear') {
      if (!linearSecret) throw new HttpError(404, 'Linear webhooks are not configured (LINEAR_WEBHOOK_SECRET)')
      return webhook(req, res, 'linear')
    }

    if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'not found')
    if (!authorized(req)) throw new HttpError(401, 'unauthorized')

    if (route === 'GET /api/cursor') return send(res, 200, { seq: maxSeq() })

    if (route === 'GET /api/events') {
      const p = url.searchParams
      const filter = {}
      for (const k of ['repo', 'issue', 'event', 'action', 'author']) if (p.has(k)) filter[k] = p.getAll(k).length > 1 ? p.getAll(k) : p.get(k)
      return longPoll(req, res, { since: p.get('since'), timeout: p.get('timeout'), limit: p.get('limit'), filter, include_payload: p.get('include_payload') === '1' })
    }

    if (route === 'POST /api/events/query') {
      const q = await readJson(req)
      return longPoll(req, res, q)
    }

    const one = url.pathname.match(/^\/api\/events\/(\d+)$/)
    if (req.method === 'GET' && one) {
      const row = db.prepare(`SELECT ${SUMMARY_COLS}, payload FROM events WHERE seq = ?`).get(Number(one[1]))
      if (!row) throw new HttpError(404, 'no such event')
      row.payload = JSON.parse(row.payload)
      return send(res, 200, row)
    }

    if (url.pathname === '/api/subscriptions') {
      if (req.method === 'GET') {
        const p = url.searchParams
        const within = Number(p.get('active_within') ?? 900)
        const cutoff = new Date(Date.now() - within * 1000).toISOString()
        const rows = db.prepare(`SELECT repo, issue, session, updated_at FROM subscriptions
          WHERE (? IS NULL OR repo = ?) AND (? IS NULL OR issue = ?) AND updated_at >= ? ORDER BY repo, issue, session`)
          .all(p.get('repo'), p.get('repo'), p.get('issue') && Number(p.get('issue')), p.get('issue') && Number(p.get('issue')), cutoff)
        const depth = Math.min(Math.max(Number(p.get('depth') ?? 2) || 0, 0), 2)
        const query = {}
        for (const k of ['repo', 'issue', 'active_within']) if (p.has(k)) query[k] = p.get(k)
        const seen = new Set(rows.map(x => `${x.repo}#${x.issue}#${x.session}`))
        for (const x of await peerSubscriptions(query, depth)) {
          const k = `${x.repo}#${x.issue}#${x.session}`
          if (!seen.has(k)) { seen.add(k); rows.push({ ...x, peer: true }) }
        }
        return send(res, 200, { subscriptions: rows })
      }
      const b = await readJson(req)
      if (typeof b.repo !== 'string' || !Number.isInteger(b.issue) || typeof b.session !== 'string' || !b.session) {
        throw new HttpError(400, 'repo (string), issue (integer), session (string) required')
      }
      if (req.method === 'PUT') {
        db.prepare(`INSERT INTO subscriptions (repo, issue, session, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (repo, issue, session) DO UPDATE SET updated_at = excluded.updated_at`).run(b.repo, b.issue, b.session, now())
        return send(res, 200, { ok: true })
      }
      if (req.method === 'DELETE') {
        db.prepare('DELETE FROM subscriptions WHERE repo = ? AND issue = ? AND session = ?').run(b.repo, b.issue, b.session)
        return send(res, 200, { ok: true })
      }
    }

    if (url.pathname === '/api/peers') {
      if (req.method === 'GET') return send(res, 200, { peers: listPeers() })
      const b = await readJson(req)
      if (typeof b.name !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(b.name)) throw new HttpError(400, 'name ([A-Za-z0-9._-]{1,64}) required')
      if (req.method === 'PUT') {
        const peerUrl = normalizePeerUrl(b.url)
        // A (re-)join means the peer is up: reset its backoff and send what queued up meanwhile.
        db.prepare(`INSERT INTO peers (name, url, updated_at) VALUES (?, ?, ?)
          ON CONFLICT (name) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at, fail_count = 0, next_at = 0,
            last_at = CASE WHEN peers.url = excluded.url THEN peers.last_at END,
            last_status = CASE WHEN peers.url = excluded.url THEN peers.last_status END`).run(b.name, peerUrl, now())
        log(`peer ${b.name} -> ${peerUrl}`)
        clearTimeout(timers.get(b.name)); timers.delete(b.name)
        kick(b.name, { probe: true })
        return send(res, 200, { ok: true, name: b.name, url: peerUrl })
      }
      if (req.method === 'DELETE') {
        const r = db.prepare('DELETE FROM peers WHERE name = ?').run(b.name)
        db.prepare('DELETE FROM outbox WHERE peer = ?').run(b.name)
        clearTimeout(timers.get(b.name)); timers.delete(b.name)
        return send(res, 200, { ok: true, removed: r.changes > 0 })
      }
    }

    throw new HttpError(404, 'not found')
  }

  // After a restart, send what is still queued (each peer gets one try now, then its backoff applies).
  for (const { peer } of db.prepare('SELECT DISTINCT peer FROM outbox').all()) kick(peer, { probe: true })

  return async (req, res) => {
    try {
      await handle(req, res)
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500
      if (status === 500) log(`error ${req.method} ${req.url}: ${err.stack ?? err}`)
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'internal error' : err.message })
    }
  }
}

function send(res, status, obj) {
  if (res.writableEnded || res.destroyed) return
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > MAX_BODY) { reject(new HttpError(413, 'body too large')); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const raw = await readBody(req)
  if (raw.length === 0) return {}
  try { return JSON.parse(raw.toString('utf8')) } catch { throw new HttpError(400, 'body must be JSON') }
}

function requireEnv(name) {
  const v = process.env[name]
  if (!v || v.length < 32) {
    console.error(`${name} must be set (at least 32 characters)`)
    process.exit(2)
  }
  return v
}

// Keep this server standalone: the Docker image copies only server.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const db = openDb(process.env.DB_PATH ?? '/data/events.db')
  const num = name => process.env[name] ? Number(process.env[name]) : undefined
  const retry = Object.fromEntries(Object.entries({
    baseMs: num('PEER_RETRY_BASE_MS'), maxMs: num('PEER_RETRY_MAX_MS'), maxAttempts: num('PEER_RETRY_MAX_ATTEMPTS'),
    maxAgeMs: num('PEER_OUTBOX_MAX_AGE_H') && num('PEER_OUTBOX_MAX_AGE_H') * 3600000, maxRows: num('PEER_OUTBOX_MAX_ROWS'),
  }).filter(([, v]) => Number.isFinite(v) && v > 0))
  const app = createApp({ db, webhookSecret: requireEnv('WEBHOOK_SECRET'), apiKey: requireEnv('API_KEY'), linearSecret: process.env.LINEAR_WEBHOOK_SECRET || null, retry })
  const port = Number(process.env.PORT ?? 8787)
  const host = process.env.HOST ?? '0.0.0.0'
  const server = http.createServer(app)
  server.requestTimeout = 0
  server.listen(port, host, () => console.error(`issue-channel listening on ${host}:${port}`))
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); db.close(); process.exit(0) })
}
