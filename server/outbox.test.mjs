import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import { openDb, createApp, backoffMs, DEFAULT_RETRY } from './server.mjs'

// Retry and fallback for peers with bad connectivity: a primary and a "flaky" peer whose answers we script.
const SECRET = 's'.repeat(40)
const KEY = 'k'.repeat(40)
const RETRY = { baseMs: 40, maxMs: 160, maxAttempts: 4, jitter: 0 }
let n = 0

async function listen(handler) {
  const server = http.createServer(handler)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}

// mode(): 'ok' | 'fail' (503) | 'reject' (401) | 'hang-up'
async function flakyPeer() {
  const peer = { got: [], attempts: [], mode: () => 'ok' }
  const s = await listen((req, res) => {
    const m = peer.mode()
    const delivery = req.headers['x-github-delivery']
    peer.attempts.push({ delivery, at: Date.now(), m })
    req.resume()
    if (m === 'hang-up') return req.socket.destroy()
    if (m === 'ok') peer.got.push(delivery)
    res.writeHead(m === 'ok' ? 201 : m === 'reject' ? 401 : 503).end('{}')
  })
  return Object.assign(peer, s)
}

async function primary({ db = openDb(':memory:'), retry = RETRY } = {}) {
  const logs = []
  const s = await listen(createApp({ db, webhookSecret: SECRET, apiKey: KEY, log: m => logs.push(m), retry }))
  const api = (path, init = {}) => fetch(`${s.url}${path}`, { ...init, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' } }).then(r => r.json())
  const hook = (delivery = `o-${++n}`) => {
    const raw = JSON.stringify({ action: 'created', repository: { full_name: 'o/r' }, issue: { number: 1 }, comment: { id: ++n, body: delivery, user: { login: 'me' } } })
    return fetch(`${s.url}/webhook/github`, { method: 'POST', body: raw, headers: { 'x-github-event': 'issue_comment', 'x-github-delivery': delivery,
      'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex') } })
  }
  const peers = async () => (await api('/api/peers')).peers
  const join = (name, url) => api('/api/peers', { method: 'PUT', body: JSON.stringify({ name, url }) })
  return { ...s, db, logs, api, hook, peers, join }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, ms = 4000) {
  const end = Date.now() + ms
  while (!(await fn())) { if (Date.now() > end) return false; await sleep(10) }
  return true
}

test('backoff doubles per failure, is capped, and jitters within bounds', () => {
  const c = { baseMs: 1000, maxMs: 8000, jitter: 0 }
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(f => backoffMs(f, c)), [1000, 2000, 4000, 8000, 8000, 8000])
  const j = { ...c, jitter: 0.2 }
  assert.equal(backoffMs(3, j, () => 0), 3200)
  assert.equal(backoffMs(3, j, () => 1), 4800)
  // Defaults: about 37 minutes of retries before a peer is parked.
  const total = Array.from({ length: DEFAULT_RETRY.maxAttempts - 1 }, (_, i) => backoffMs(i + 1, { ...DEFAULT_RETRY, jitter: 0 })).reduce((a, b) => a + b)
  assert.ok(total > 30 * 60e3 && total < 45 * 60e3, String(total))
})

test('a flaky peer: waits longer and longer, then gets every copy, in order', async () => {
  const peer = await flakyPeer(), p = await primary()
  try {
    let fails = 3
    peer.mode = () => (fails-- > 0 ? 'fail' : 'ok')
    await p.join('flaky', peer.url)
    for (const d of ['a1', 'a2', 'a3']) await p.hook(d)
    assert.ok(await until(() => peer.got.length === 3))
    assert.deepEqual(peer.got, ['a1', 'a2', 'a3'])
    // One sender per peer: while it was down, only the head of the queue was tried.
    assert.deepEqual(peer.attempts.slice(0, 4).map(a => a.delivery), ['a1', 'a1', 'a1', 'a1'])
    const gaps = peer.attempts.slice(1, 4).map((a, i) => a.at - peer.attempts[i].at)
    assert.ok(gaps[0] >= 35 && gaps[1] >= 75 && gaps[2] >= 150, `gaps ${gaps}`)
    assert.ok(gaps[1] > gaps[0] && gaps[2] > gaps[1], `gaps ${gaps}`)
    const [st] = await p.peers()
    assert.deepEqual([st.pending, st.fail_count, st.parked, st.last_status], [0, 0, false, '201'])
  } finally { peer.close(); p.close() }
})

test('max retry limit: the peer is parked (no more tries), copies stay queued, a re-join delivers them', async () => {
  const peer = await flakyPeer(), p = await primary()
  try {
    peer.mode = () => 'hang-up'
    await p.join('laptop', peer.url)
    await p.hook('b1'); await p.hook('b2')
    assert.ok(await until(async () => (await p.peers())[0].parked))
    const tries = peer.attempts.length
    assert.equal(tries, RETRY.maxAttempts)
    await sleep(400)
    assert.equal(peer.attempts.length, tries, 'no retries once parked')
    const [st] = await p.peers()
    assert.deepEqual([st.pending, st.fail_count, st.next_at], [2, RETRY.maxAttempts, null])
    assert.ok(p.logs.some(l => /parked until it re-joins/.test(l)))
    // Fallback: the box comes back (e.g. a new quick-tunnel URL) and re-joins; the backlog goes out at once.
    peer.mode = () => 'ok'
    await p.join('laptop', peer.url)
    assert.ok(await until(() => peer.got.length === 2))
    assert.deepEqual(peer.got, ['b1', 'b2'])
    assert.deepEqual((await p.peers()).map(x => [x.pending, x.parked]), [[0, false]])
  } finally { peer.close(); p.close() }
})

test('a parked peer gets one probe per new webhook, and drains when it answers', async () => {
  const peer = await flakyPeer(), p = await primary()
  try {
    peer.mode = () => 'fail'
    await p.join('desk', peer.url)
    await p.hook('c1')
    assert.ok(await until(async () => (await p.peers())[0].parked))
    const tries = peer.attempts.length
    await p.hook('c2')
    assert.ok(await until(() => peer.attempts.length === tries + 1))
    await sleep(300)
    assert.equal(peer.attempts.length, tries + 1, 'one probe, still parked')
    peer.mode = () => 'ok'
    await p.hook('c3')
    assert.ok(await until(() => peer.got.length === 3))
    assert.deepEqual(peer.got, ['c1', 'c2', 'c3'])
  } finally { peer.close(); p.close() }
})

test('a 4xx drops only that copy; the rest of the queue still goes out', async () => {
  const peer = await flakyPeer(), p = await primary()
  try {
    let first = true
    peer.mode = () => (first ? ((first = false), 'reject') : 'ok')
    await p.join('picky', peer.url)
    await p.hook('d1'); await p.hook('d2')
    assert.ok(await until(() => peer.got.length === 1))
    assert.deepEqual(peer.got, ['d2'])
    assert.deepEqual((await p.peers()).map(x => [x.pending, x.fail_count]), [[0, 0]])
  } finally { peer.close(); p.close() }
})

test('queued copies survive a server restart and go out when it starts again', async () => {
  const db = openDb(':memory:')
  const peer = await flakyPeer()
  let p = await primary({ db })
  try {
    peer.mode = () => 'fail'
    await p.join('box', peer.url)
    await p.hook('e1')
    assert.ok(await until(async () => (await p.peers())[0].parked))
    p.close()
    peer.mode = () => 'ok'
    p = await primary({ db }) // same DB, new app = restart
    assert.ok(await until(() => peer.got.length === 1))
    assert.deepEqual(peer.got, ['e1'])
  } finally { peer.close(); p.close() }
})

test('the outbox is bounded: the oldest copies are dropped past maxRows', async () => {
  const peer = await flakyPeer(), p = await primary({ retry: { ...RETRY, maxRows: 2 } })
  try {
    peer.mode = () => 'fail'
    await p.join('full', peer.url)
    for (const d of ['f1', 'f2', 'f3', 'f4']) await p.hook(d)
    assert.equal((await p.peers())[0].pending, 2)
    assert.ok(p.logs.some(l => /dropped 1 old copies/.test(l)))
    peer.mode = () => 'ok'
    await p.join('full', peer.url)
    assert.ok(await until(() => peer.got.length === 2))
    assert.deepEqual(peer.got, ['f3', 'f4'])
  } finally { peer.close(); p.close() }
})

test('removing a peer drops its queue and stops its retries', async () => {
  const peer = await flakyPeer(), p = await primary()
  try {
    peer.mode = () => 'fail'
    await p.join('bye', peer.url)
    await p.hook('g1')
    assert.ok(await until(() => peer.attempts.length >= 1))
    await p.api('/api/peers', { method: 'DELETE', body: JSON.stringify({ name: 'bye' }) })
    const tries = peer.attempts.length
    await sleep(400)
    assert.ok(peer.attempts.length <= tries + 1, 'at most an in-flight try')
    assert.equal(p.db.prepare('SELECT COUNT(*) AS c FROM outbox').get().c, 0)
  } finally { peer.close(); p.close() }
})
