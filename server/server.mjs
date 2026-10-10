#!/usr/bin/env node
// issue-channel server: GitHub webhook receiver + SQLite event log + long-poll API.
// Dependency-free (Node >= 24, node:sqlite).
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MAX_BODY = 5 * 1024 * 1024
// Cloudflare closes proxied requests that send no response for ~100s, so cap waits below that.
const MAX_WAIT_S = 90
const MAX_LIMIT = 500
// Forwarded webhooks carry this header; a server never forwards them again.
const HOP_HEADER = 'x-issue-channel-hop'
const FORWARD_HEADERS = ['content-type', 'user-agent', 'x-github-event', 'x-github-delivery', 'x-github-hook-id',
  'x-github-hook-installation-target-id', 'x-github-hook-installation-target-type', 'x-hub-signature', 'x-hub-signature-256']
const PEER_TIMEOUT_MS = 10000
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
      last_status TEXT
    );
  `)
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

const SUMMARY_COLS = 'seq, delivery_id, event, action, repo, issue, comment_id, author, title, body, created_at, updated_at, received_at'

export function normalizePeerUrl(u) {
  let url
  try { url = new URL(String(u)) } catch { throw new HttpError(400, 'url must be an absolute http(s) URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash) throw new HttpError(400, 'url must be an absolute http(s) URL without query')
  return url.origin + url.pathname.replace(/\/+$/, '')
}

export function createApp({ db, webhookSecret, apiKey, now = () => new Date().toISOString(), log = console.error,
  fetch = globalThis.fetch, forwardRetryMs = [2000, 10000, 30000, 60000, 120000] }) {
  if (!webhookSecret || !apiKey) throw new Error('webhookSecret and apiKey are required')
  const waiters = new Set()
  const insert = db.prepare(`
    INSERT INTO events (delivery_id, event, action, repo, issue, comment_id, author, title, body, created_at, updated_at, received_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  const listPeers = () => db.prepare('SELECT name, url, updated_at, last_at, last_status FROM peers ORDER BY name').all()
  const setPeerStatus = db.prepare('UPDATE peers SET last_at = ?, last_status = ? WHERE name = ?')

  // Replicate a webhook to every peer as the same HTTP request; the peer checks the signature itself.
  async function forward(peer, raw, headers, delivery) {
    const h = { [HOP_HEADER]: '1' }
    for (const k of FORWARD_HEADERS) if (headers[k] != null) h[k] = String(headers[k])
    let status = ''
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(`${peer.url}/webhook/github`, { method: 'POST', headers: h, body: raw, signal: AbortSignal.timeout(PEER_TIMEOUT_MS) })
        status = String(r.status)
        await r.arrayBuffer().catch(() => {})
        if (r.ok) break
        if (r.status >= 400 && r.status < 500) break // the peer rejected it (bad signature, ...): retrying won't help
      } catch (e) { status = `error: ${e.cause?.code ?? e.name ?? e.message}` }
      if (attempt >= forwardRetryMs.length) break
      await new Promise(resolve => setTimeout(resolve, forwardRetryMs[attempt]))
    }
    setPeerStatus.run(now(), status, peer.name)
    log(`forward delivery=${delivery} -> ${peer.name} ${status}`)
    return status
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

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x')
    const route = `${req.method} ${url.pathname}`

    if (route === 'GET /healthz') return send(res, 200, { ok: true })

    if (route === 'POST /webhook/github') {
      const raw = await readBody(req)
      if (!verifySignature(webhookSecret, raw, req.headers['x-hub-signature-256'])) {
        throw new HttpError(401, 'bad signature')
      }
      const delivery = req.headers['x-github-delivery']
      const event = req.headers['x-github-event']
      if (!delivery || !event) throw new HttpError(400, 'missing GitHub headers')
      let payload
      try { payload = JSON.parse(raw.toString('utf8')) } catch { throw new HttpError(400, 'payload must be JSON') }
      const e = extract(String(event), payload)
      const r = insert.run(String(delivery), e.event, e.action, e.repo, e.issue, e.comment_id, e.author, e.title, e.body,
        e.created_at, e.updated_at, now(), raw.toString('utf8'))
      const stored = r.changes > 0
      if (stored) for (const w of [...waiters]) w()
      const hop = req.headers[HOP_HEADER] != null
      log(`webhook ${event}.${e.action ?? '-'} ${e.repo ?? '-'}#${e.issue ?? '-'} delivery=${delivery} ${stored ? 'stored' : 'duplicate'}${hop ? ' (forwarded)' : ''}`)
      if (stored && !hop) for (const peer of listPeers()) forward(peer, raw, req.headers, delivery).catch(err => log(`forward ${peer.name}: ${err.message}`))
      return send(res, stored ? 201 : 200, { stored, duplicate: !stored })
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
        db.prepare(`INSERT INTO peers (name, url, updated_at) VALUES (?, ?, ?)
          ON CONFLICT (name) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at,
            last_at = CASE WHEN peers.url = excluded.url THEN peers.last_at END,
            last_status = CASE WHEN peers.url = excluded.url THEN peers.last_status END`).run(b.name, peerUrl, now())
        log(`peer ${b.name} -> ${peerUrl}`)
        return send(res, 200, { ok: true, name: b.name, url: peerUrl })
      }
      if (req.method === 'DELETE') {
        const r = db.prepare('DELETE FROM peers WHERE name = ?').run(b.name)
        return send(res, 200, { ok: true, removed: r.changes > 0 })
      }
    }

    throw new HttpError(404, 'not found')
  }

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

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb(process.env.DB_PATH ?? '/data/events.db')
  const app = createApp({ db, webhookSecret: requireEnv('WEBHOOK_SECRET'), apiKey: requireEnv('API_KEY') })
  const port = Number(process.env.PORT ?? 8787)
  const host = process.env.HOST ?? '0.0.0.0'
  const server = http.createServer(app)
  server.requestTimeout = 0
  server.listen(port, host, () => console.error(`issue-channel listening on ${host}:${port}`))
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); db.close(); process.exit(0) })
}
