import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import { openDb, createApp, normalizePeerUrl } from './server.mjs'

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
  // The peers stored it as forwarded and did not send it back (no loop): the primary still has one copy
  // and logged no duplicate.
  await new Promise(r => setTimeout(r, 200))
  assert.ok(nodes.laptop.logs.some(l => /delivery=rep-1 stored \(forwarded\)/.test(l)))
  assert.equal((await eventsOn('primary', 10)).length, 1)
  assert.ok(!nodes.primary.logs.some(l => /delivery=rep-1 duplicate/.test(l)))
  const peers = (await json('primary', '/api/peers')).peers
  assert.deepEqual(peers.map(p => p.last_status), ['201', '201'])
})

test('a redelivery (duplicate) is not forwarded again; a forwarded request is never re-forwarded', async () => {
  await hook('primary', comment(11, 110, 'x'), { delivery: 'rep-2' })
  await eventually(async () => (await eventsOn('laptop', 11)).length)
  const before = nodes.primary.logs.filter(l => l.startsWith('forward ')).length
  const dup = await hook('primary', comment(11, 110, 'x'), { delivery: 'rep-2' })
  assert.equal(dup.status, 200)
  // laptop gets a forwarded request directly: it stores it but must not pass it on to the primary.
  await hook('laptop', comment(12, 120, 'y'), { delivery: 'rep-3', headers: { 'x-issue-channel-hop': '1' } })
  await new Promise(r => setTimeout(r, 200))
  assert.equal(nodes.primary.logs.filter(l => l.startsWith('forward ')).length, before)
  assert.equal((await eventsOn('primary', 12)).length, 0)
})

test('a webhook that reaches a joined box directly is replicated to the primary', async () => {
  await hook('desk', comment(13, 130, 'z'), { delivery: 'rep-4' })
  assert.equal((await eventually(async () => (await eventsOn('primary', 13)).length)), 1)
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
