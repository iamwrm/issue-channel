import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import { openDb, createApp, compileFilter } from './server.mjs'

const SECRET = 's'.repeat(40)
const KEY = 'k'.repeat(40)
let server, base, seqDelivery = 0

before(async () => {
  const db = openDb(':memory:')
  server = http.createServer(createApp({ db, webhookSecret: SECRET, apiKey: KEY, log: () => {} }))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

function sign(body, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
}

async function hook(event, payload, { secret = SECRET, delivery = `d-${++seqDelivery}` } = {}) {
  const body = JSON.stringify(payload)
  return fetch(`${base}/webhook/github`, {
    method: 'POST',
    headers: { 'x-github-event': event, 'x-github-delivery': delivery, 'x-hub-signature-256': sign(body, secret), 'content-type': 'application/json' },
    body,
  })
}

function api(path, init = {}) {
  return fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...init.headers } })
}

const comment = (issue, id, body, action = 'created', login = 'alice') => ({
  action,
  repository: { full_name: 'o/r' },
  issue: { number: issue, title: `Issue ${issue}`, body: 'issue body', created_at: 't0', updated_at: 't0' },
  comment: { id, body, user: { login }, created_at: 't1', updated_at: 't1' },
  sender: { login },
})

test('rejects unsigned and wrongly signed webhooks without storing', async () => {
  const before = await (await api('/api/cursor')).json()
  const bad = await hook('issue_comment', comment(1, 1, 'x'), { secret: 'wrong'.repeat(10) })
  assert.equal(bad.status, 401)
  const unsigned = await fetch(`${base}/webhook/github`, { method: 'POST', headers: { 'x-github-event': 'ping', 'x-github-delivery': 'u' }, body: '{}' })
  assert.equal(unsigned.status, 401)
  assert.deepEqual(await (await api('/api/cursor')).json(), before)
})

test('API requires the key', async () => {
  assert.equal((await fetch(`${base}/api/cursor`)).status, 401)
  assert.equal((await fetch(`${base}/api/cursor`, { headers: { authorization: 'Bearer nope' } })).status, 401)
  assert.equal((await fetch(`${base}/healthz`)).status, 200)
})

test('stores events, extracts columns, dedupes redeliveries', async () => {
  const r1 = await hook('issue_comment', comment(2, 20, 'hello'), { delivery: 'dup-1' })
  assert.equal(r1.status, 201)
  const r2 = await hook('issue_comment', comment(2, 20, 'hello'), { delivery: 'dup-1' })
  assert.equal(r2.status, 200)
  assert.equal((await r2.json()).duplicate, true)
  const { events } = await (await api('/api/events?repo=o/r&issue=2')).json()
  assert.equal(events.length, 1)
  assert.equal(events[0].author, 'alice')
  assert.equal(events[0].comment_id, 20)
  assert.equal(events[0].body, 'hello')
  assert.equal(events[0].title, 'Issue 2')
  const full = await (await api(`/api/events/${events[0].seq}`)).json()
  assert.equal(full.payload.comment.id, 20)
})

test('long poll wakes on a matching webhook and times out empty otherwise', async () => {
  const { seq } = await (await api('/api/cursor')).json()
  const t0 = Date.now()
  const pending = api('/api/events/query', { method: 'POST', body: JSON.stringify({ since: seq, timeout: 10, filter: { repo: 'o/r', issue: 3 } }) })
  await new Promise(r => setTimeout(r, 200))
  await hook('issue_comment', comment(4, 40, 'other issue'))
  await hook('issue_comment', comment(3, 30, '/bot hi'))
  const res = await (await pending).json()
  assert.ok(Date.now() - t0 < 3000)
  assert.equal(res.events.length, 1)
  assert.equal(res.events[0].comment_id, 30)
  assert.equal(res.next, res.events[0].seq)

  const t1 = Date.now()
  const empty = await (await api('/api/events/query', { method: 'POST', body: JSON.stringify({ since: res.next, timeout: 1, filter: { issue: 999 } }) })).json()
  assert.ok(Date.now() - t1 >= 900)
  assert.deepEqual(empty.events, [])
  assert.ok(empty.next >= res.next)
})

test('structured filters: contains, like, regex, lists, exclusion', async () => {
  await hook('issue_comment', comment(5, 50, 'needle in hay'))
  await hook('issue_comment', comment(5, 51, 'reply <!-- issue-channel:bot -->', 'created', 'bot'))
  await hook('issue_comment', comment(5, 52, 'edited text', 'edited'))
  const q = filter => api('/api/events/query', { method: 'POST', body: JSON.stringify({ filter: { issue: 5, ...filter } }) }).then(r => r.json())
  assert.deepEqual((await q({ body: { contains: 'needle' } })).events.map(e => e.comment_id), [50])
  assert.deepEqual((await q({ body: { like: '%TEXT' } })).events.map(e => e.comment_id), [52])
  assert.deepEqual((await q({ body: { regex: '^needle' } })).events.map(e => e.comment_id), [50])
  assert.deepEqual((await q({ action: ['edited'] })).events.map(e => e.comment_id), [52])
  assert.deepEqual((await q({ author: 'bot' })).events.map(e => e.comment_id), [51])
  assert.deepEqual((await q({ exclude_body_contains: 'issue-channel:bot' })).events.map(e => e.comment_id), [50, 52])
  assert.deepEqual((await q({ title: { contains: 'Issue 5' } })).events.length, 3)
})

test('rejects raw SQL and malformed filters', async () => {
  assert.throws(() => compileFilter({ where: '1=1' }), /unknown filter key/)
  assert.throws(() => compileFilter({ body: { contains: 'a', like: 'b' } }), /exactly one/)
  assert.throws(() => compileFilter({ body: { regex: '(' } }), /invalid regex/)
  const r = await api('/api/events/query', { method: 'POST', body: JSON.stringify({ filter: { sql: 'drop table events' } }) })
  assert.equal(r.status, 400)
  // Injection attempts are inert parameters.
  const { where, params } = compileFilter({ repo: "x' OR 1=1 --" })
  assert.deepEqual(where, ['repo = ?'])
  assert.deepEqual(params, ["x' OR 1=1 --"])
})

test('subscriptions registry', async () => {
  const body = JSON.stringify({ repo: 'o/r', issue: 7, session: 'review' })
  assert.equal((await api('/api/subscriptions', { method: 'PUT', body })).status, 200)
  let { subscriptions } = await (await api('/api/subscriptions?repo=o/r&issue=7')).json()
  assert.deepEqual(subscriptions.map(s => s.session), ['review'])
  await api('/api/subscriptions', { method: 'DELETE', body })
  ;({ subscriptions } = await (await api('/api/subscriptions?repo=o/r&issue=7')).json())
  assert.deepEqual(subscriptions, [])
})
