import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import { openDb, createApp, normalizePeerUrl, peerSignature, MAX_HOPS } from './server.mjs'

// Three servers sharing one .env: a primary (gets the GitHub webhook) and two joined boxes.
const SECRET = 's'.repeat(40)
const KEY = 'k'.repeat(40)
const nodes = {}
let n = 0

async function start(name) {
  const logs = []
  const server = http.createServer(createApp({ db: openDb(':memory:'), webhookSecret: SECRET, apiKey: KEY, log: m => logs.push(m), forwardRetryMs: [50, 50] }))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  nodes[name] = { server, logs, base: `http://127.0.0.1:${server.address().port}` }
}

before(async () => { for (const name of ['primary', 'laptop', 'desk']) await start(name) })
after(() => { for (const { server } of Object.values(nodes)) server.close() })

const api = (name, path, init = {}) =>
  fetch(`${nodes[name].base}${path}`, { ...init, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...init.headers } })
const json = (name, path, init) => api(name, path, init).then(r => r.json())
const put = (name, path, body) => json(name, path, { method: 'PUT', body: JSON.stringify(body) })
const del = (name, path, body) => json(name, path, { method: 'DELETE', body: JSON.stringify(body) })

function hook(name, body, { delivery = `p-${++n}`, secret = SECRET, headers = {} } = {}) {
  const raw = JSON.stringify(body)
  return fetch(`${nodes[name].base}/webhook/github`, {
    method: 'POST',
    headers: { 'x-github-event': 'issue_comment', 'x-github-delivery': delivery, 'content-type': 'application/json',
      'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex'), ...headers },
    body: raw,
  })
}
const comment = (issue, id, body) => ({
  action: 'created', repository: { full_name: 'o/r' },
  issue: { number: issue, title: 't', body: '' }, comment: { id, body, user: { login: 'me' } }, sender: { login: 'me' },
})

async function eventually(fn, ms = 3000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v || Date.now() > end) return v
    await new Promise(r => setTimeout(r, 25))
  }
}
const eventsOn = async (name, issue) => (await json(name, `/api/events?repo=o/r&issue=${issue}`)).events

test('peer registry: put, normalize, list, delete', async () => {
  assert.equal(normalizePeerUrl('https://x.trycloudflare.com/'), 'https://x.trycloudflare.com')
  assert.throws(() => normalizePeerUrl('ftp://x'), /http\(s\)/)
  assert.throws(() => normalizePeerUrl('https://x/?a=1'), /without query/)
  assert.equal((await api('primary', '/api/peers', { method: 'PUT', body: JSON.stringify({ name: 'bad name', url: 'https://x' }) })).status, 400)
  assert.equal((await fetch(`${nodes.primary.base}/api/peers`)).status, 401)

  await put('primary', '/api/peers', { name: 'tmp', url: 'https://old.example/' })
  await put('primary', '/api/peers', { name: 'tmp', url: 'https://new.example' })
  assert.deepEqual((await json('primary', '/api/peers')).peers.map(p => [p.name, p.url]), [['tmp', 'https://new.example']])
  assert.deepEqual(await del('primary', '/api/peers', { name: 'tmp' }), { ok: true, removed: true })
  assert.deepEqual((await json('primary', '/api/peers')).peers, [])
})

test('join: a webhook on the primary is replicated to every peer, once, with its signature intact', async () => {
  // laptop and desk join the primary: each registers itself there and adds the primary locally.
  for (const box of ['laptop', 'desk']) {
    await put('primary', '/api/peers', { name: box, url: nodes[box].base })
    await put(box, '/api/peers', { name: 'primary', url: nodes.primary.base })
  }
  const r = await hook('primary', comment(10, 100, '/bot hi'), { delivery: 'rep-1' })
  assert.equal(r.status, 201)
  for (const box of ['laptop', 'desk']) {
    const ev = await eventually(async () => (await eventsOn(box, 10)).length && eventsOn(box, 10))
    assert.equal(ev.length, 1, box)
    assert.equal(ev[0].delivery_id, 'rep-1')
    assert.equal(ev[0].body, '/bot hi')
  }
  // Each peer stored it as hop 1 and relayed it once; the primary already had it, so the flood stops there.
  await new Promise(r => setTimeout(r, 200))
  assert.ok(nodes.laptop.logs.some(l => /delivery=rep-1 stored \(forwarded, hop 1\)/.test(l)))
  assert.equal((await eventsOn('primary', 10)).length, 1)
  assert.equal(nodes.primary.logs.filter(l => /delivery=rep-1 duplicate/.test(l)).length, 2)
  const peers = (await json('primary', '/api/peers')).peers
  assert.deepEqual(peers.map(p => p.last_status), ['201', '201'])
})

const forwards = (name, delivery) => nodes[name].logs.filter(l => l.startsWith(`forward delivery=${delivery} `)).length

test('a redelivery (duplicate) is not forwarded again', async () => {
  await hook('primary', comment(11, 110, 'x'), { delivery: 'rep-2' })
  await eventually(async () => (await eventsOn('laptop', 11)).length && (await eventsOn('desk', 11)).length)
  await new Promise(r => setTimeout(r, 200))
  const before = forwards('primary', 'rep-2')
  assert.equal((await hook('primary', comment(11, 110, 'x'), { delivery: 'rep-2' })).status, 200)
  await new Promise(r => setTimeout(r, 200))
  assert.equal(forwards('primary', 'rep-2'), before)
})

test("a joined box's own webhook reaches the primary and, through it, the other boxes; the flood ends", async () => {
  await hook('desk', comment(13, 130, 'z'), { delivery: 'rep-4' })
  for (const box of ['primary', 'laptop']) assert.equal((await eventually(async () => (await eventsOn(box, 13)).length)), 1, box)
  await new Promise(r => setTimeout(r, 300))
  // desk -> primary; primary -> laptop + desk (dup); laptop -> primary (dup). Every server forwarded once.
  assert.deepEqual(['desk', 'primary', 'laptop'].map(b => forwards(b, 'rep-4')), [1, 2, 1])
  for (const box of ['primary', 'laptop', 'desk']) assert.equal((await eventsOn(box, 13)).length, 1, box)
})

test('auth: a copy needs a valid peer signature, so the hop count and delivery id cannot be forged', async () => {
  const body = comment(16, 160, 'forged')
  const raw = JSON.stringify(body)
  const sig = (o, secret = SECRET) => peerSignature(secret, { event: 'issue_comment', ...o }, raw)
  // GitHub-signed body, hop header but no or a wrong peer signature: rejected, nothing stored.
  assert.equal((await hook('laptop', body, { delivery: 'f-1', headers: { 'x-issue-channel-hop': '1' } })).status, 401)
  assert.equal((await hook('laptop', body, { delivery: 'f-2', headers: { 'x-issue-channel-hop': '1', 'x-issue-channel-signature': sig({ delivery: 'f-2', hop: 1 }, 'x'.repeat(40)) } })).status, 401)
  // A valid peer signature for another delivery id or hop count does not carry over.
  assert.equal((await hook('laptop', body, { delivery: 'f-3', headers: { 'x-issue-channel-hop': '2', 'x-issue-channel-signature': sig({ delivery: 'f-3', hop: 1 }) } })).status, 401)
  assert.equal((await hook('laptop', body, { delivery: 'f-4', headers: { 'x-issue-channel-hop': '1', 'x-issue-channel-signature': sig({ delivery: 'other', hop: 1 }) } })).status, 401)
  assert.equal((await hook('laptop', body, { delivery: 'f-5', headers: { 'x-issue-channel-hop': String(MAX_HOPS + 1), 'x-issue-channel-signature': sig({ delivery: 'f-5', hop: MAX_HOPS + 1 }) } })).status, 400)
  assert.equal((await eventsOn('laptop', 16)).length, 0)
  // The GitHub signature is still required on a copy.
  const peerOnly = await fetch(`${nodes.laptop.base}/webhook/github`, { method: 'POST', body: raw, headers: {
    'x-github-event': 'issue_comment', 'x-github-delivery': 'f-6', 'x-issue-channel-hop': '1', 'x-issue-channel-signature': sig({ delivery: 'f-6', hop: 1 }) } })
  assert.equal(peerOnly.status, 401)
  // A valid copy at the last hop is stored but not relayed further.
  const ok = await hook('laptop', body, { delivery: 'f-7', headers: { 'x-issue-channel-hop': String(MAX_HOPS), 'x-issue-channel-signature': sig({ delivery: 'f-7', hop: MAX_HOPS }) } })
  assert.equal(ok.status, 201)
  await new Promise(r => setTimeout(r, 200))
  assert.equal(forwards('laptop', 'f-7'), 0)
  assert.equal((await eventsOn('primary', 16)).length, 0)
})

test('a peer with another secret rejects the copy; the primary records it and does not retry a 401', async () => {
  const other = http.createServer(createApp({ db: openDb(':memory:'), webhookSecret: 'x'.repeat(40), apiKey: KEY, log: () => {} }))
  await new Promise(r => other.listen(0, '127.0.0.1', r))
  try {
    await put('primary', '/api/peers', { name: 'stranger', url: `http://127.0.0.1:${other.address().port}` })
    await hook('primary', comment(14, 140, 'w'), { delivery: 'rep-5' })
    const status = await eventually(async () => (await json('primary', '/api/peers')).peers.find(p => p.name === 'stranger').last_status)
    assert.equal(status, '401')
    assert.equal(nodes.primary.logs.filter(l => /rep-5 -> stranger/.test(l)).length, 1)
  } finally {
    await del('primary', '/api/peers', { name: 'stranger' })
    other.close()
  }
})

test('an unreachable peer is retried, then recorded, without blocking the webhook', async () => {
  await put('primary', '/api/peers', { name: 'gone', url: 'http://127.0.0.1:9' })
  try {
    const t0 = Date.now()
    assert.equal((await hook('primary', comment(15, 150, 'v'), { delivery: 'rep-6' })).status, 201)
    assert.ok(Date.now() - t0 < 1000)
    const status = await eventually(async () => (await json('primary', '/api/peers')).peers.find(p => p.name === 'gone').last_status)
    assert.match(status, /^error/)
  } finally {
    await del('primary', '/api/peers', { name: 'gone' })
  }
})

test('subscriptions merge across boxes, so /bot <name> can target a session on another box', async () => {
  await put('laptop', '/api/subscriptions', { repo: 'o/r', issue: 20, session: 'laptop-agent' })
  await put('desk', '/api/subscriptions', { repo: 'o/r', issue: 20, session: 'desk-agent' })
  await put('primary', '/api/subscriptions', { repo: 'o/r', issue: 20, session: 'default' })
  const names = async box => (await json(box, '/api/subscriptions?repo=o/r&issue=20')).subscriptions.map(s => s.session).sort()
  // primary sees both boxes; a box sees the primary and, through it, the other box (2 hops).
  for (const box of ['primary', 'laptop', 'desk']) assert.deepEqual(await names(box), ['default', 'desk-agent', 'laptop-agent'], box)
  const local = (await json('laptop', '/api/subscriptions?repo=o/r&issue=20&depth=0')).subscriptions.map(s => s.session)
  assert.deepEqual(local, ['laptop-agent'])
  const fromPeer = (await json('primary', '/api/subscriptions?repo=o/r&issue=20')).subscriptions.find(s => s.session === 'laptop-agent')
  assert.equal(fromPeer.peer, true)
})

test('a peer that is down does not break the subscription list', async () => {
  await put('primary', '/api/peers', { name: 'gone', url: 'http://127.0.0.1:9' })
  try {
    const { subscriptions } = await json('primary', '/api/subscriptions?repo=o/r&issue=20')
    assert.ok(subscriptions.some(s => s.session === 'default'))
  } finally {
    await del('primary', '/api/peers', { name: 'gone' })
  }
})
