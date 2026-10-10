import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import { openDb, createApp, extractLinear } from './server.mjs'

// Linear webhooks: signature, replay guard, mapping onto the event model, 200 answers, peer copies.
const SECRET = 's'.repeat(40)
const KEY = 'k'.repeat(40)
const LINEAR = 'l'.repeat(40)
const nodes = {}
let n = 0

async function start(name, opts = {}) {
  const logs = []
  const app = createApp({ db: openDb(':memory:'), webhookSecret: SECRET, apiKey: KEY, linearSecret: LINEAR, log: m => logs.push(m),
    retry: { baseMs: 40, maxMs: 200, maxAttempts: 3, jitter: 0 }, ...opts })
  const server = http.createServer(app)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  nodes[name] = { server, logs, base: `http://127.0.0.1:${server.address().port}` }
}
before(async () => { await start('a'); await start('b'); await start('off', { linearSecret: null }) })
after(() => { for (const { server } of Object.values(nodes)) server.close() })

const api = (name, path, init = {}) =>
  fetch(`${nodes[name].base}${path}`, { ...init, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...init.headers } }).then(r => r.json())

const comment = ({ action = 'create', id = `c-${++n}`, body = 'hello', parentId = null, email = 'me@example.com', botActor = null, issue = 'ENG-123', updatedFrom } = {}) => ({
  action, type: 'Comment', createdAt: '2026-10-10T07:00:00.000Z', url: 'https://linear.app/x/issue/ENG-123#comment-1',
  actor: { id: 'u1', name: 'Me', email, type: 'user' },
  data: { id, body, issueId: 'iss-uuid', parentId, userId: 'u1', botActor, createdAt: '2026-10-10T07:00:00.000Z', updatedAt: '2026-10-10T07:00:01.000Z',
    user: botActor ? null : { id: 'u1', name: 'Me', email }, issue: { id: 'iss-uuid', identifier: issue, title: 'Try Linear', teamId: 't1', team: { id: 't1', key: 'ENG', name: 'Eng' }, url: 'https://linear.app/x/issue/ENG-123' } },
  ...(updatedFrom ? { updatedFrom } : {}),
  webhookTimestamp: Date.now(), webhookId: 'wh-1',
})

function linearHook(name, payload, { delivery = `ld-${++n}`, secret = LINEAR, event = payload.type, headers = {}, raw } = {}) {
  raw ??= JSON.stringify(payload)
  return fetch(`${nodes[name].base}/webhook/linear`, {
    method: 'POST', body: raw,
    headers: { 'content-type': 'application/json; charset=utf-8', 'user-agent': 'Linear-Webhook', 'linear-delivery': delivery, 'linear-event': event,
      'linear-signature': crypto.createHmac('sha256', secret).update(raw).digest('hex'), 'linear-timestamp': String(payload.webhookTimestamp), ...headers },
  })
}
const events = async (name, filter = { repo: 'linear:ENG', issue: 123 }) => (await api(name, '/api/events/query', { method: 'POST', body: JSON.stringify({ filter }) })).events

test('mapping: a Linear comment becomes an issue_comment on ("linear:ENG", 123), with thread and bot info', () => {
  const e = extractLinear('Comment', comment({ id: 'c1', body: '/bot hi', parentId: 'root-1' }))
  assert.deepEqual([e.event, e.action, e.repo, e.issue, e.comment_id, e.author, e.title, e.body, e.parent_id, e.bot_actor],
    ['issue_comment', 'created', 'linear:ENG', 123, 'c1', 'me@example.com', 'Try Linear', '/bot hi', 'root-1', null])
  assert.equal(extractLinear('Comment', comment({ action: 'update', updatedFrom: { body: 'old' } })).action, 'edited')
  assert.equal(extractLinear('Comment', comment({ action: 'update', updatedFrom: { reactionData: [] } })).action, 'updated', 'not a text edit')
  assert.equal(extractLinear('Comment', comment({ action: 'remove' })).action, 'deleted')
  const bot = extractLinear('Comment', comment({ botActor: { id: 'app1', name: 'issue-channel', type: 'oauthClient' } }))
  assert.equal(bot.author, 'app:issue-channel')
  assert.ok(bot.bot_actor)
  // Live: the app's own comments carry botActor null and come from the app user <uuid>@oauthapp.linear.app.
  const appUser = extractLinear('Comment', comment({ email: '247afd61-dc26-4faa-a3ad-7004f7042611@oauthapp.linear.app' }))
  assert.equal(appUser.author, '247afd61-dc26-4faa-a3ad-7004f7042611@oauthapp.linear.app')
  assert.ok(appUser.bot_actor, 'marked as a bot')
  const issue = extractLinear('Issue', { action: 'update', type: 'Issue', actor: { email: 'me@example.com' }, updatedFrom: { description: 'x' },
    data: { identifier: 'ENG-123', title: 'T', description: 'new body', team: { key: 'ENG' }, number: 123 } })
  assert.deepEqual([issue.event, issue.action, issue.repo, issue.issue, issue.body], ['issues', 'edited', 'linear:ENG', 123, 'new body'])
  // Live: the app's own description edit has actor type "user" with the app user's email.
  const appEdit = extractLinear('Issue', { action: 'update', type: 'Issue', updatedFrom: { description: 'x' },
    actor: { id: 'e13c', name: 'issue-channel', email: '247afd61@oauthapp.linear.app', type: 'user' }, data: { identifier: 'REN-106', description: 'y' } })
  assert.ok(appEdit.bot_actor, 'app issue edits are marked as the bot')
  assert.equal(extractLinear('Reaction', { action: 'create', data: { id: 'r1' } }).event, 'linear:Reaction')
})

test('a signed Linear webhook is stored, answered with 200, and deduped by Linear-Delivery', async () => {
  const p = comment({ id: 'c-store', body: '/bot hello', parentId: 'root-9' })
  const r1 = await linearHook('a', p, { delivery: 'L-1' })
  assert.equal(r1.status, 200, 'Linear counts anything but 200 as a failure')
  assert.deepEqual(await r1.json(), { stored: true, duplicate: false })
  const r2 = await linearHook('a', p, { delivery: 'L-1' })
  assert.equal(r2.status, 200)
  assert.equal((await r2.json()).duplicate, true)
  const ev = (await events('a')).find(e => e.comment_id === 'c-store')
  assert.deepEqual([ev.event, ev.action, ev.author, ev.body, ev.parent_id], ['issue_comment', 'created', 'me@example.com', '/bot hello', 'root-9'])
})

test('auth: wrong secret, GitHub-style signature, stale or missing timestamp are rejected; no secret configured = 404', async () => {
  assert.equal((await linearHook('a', comment(), { secret: 'x'.repeat(40) })).status, 401)
  const p = comment()
  const raw = JSON.stringify(p)
  assert.equal((await linearHook('a', p, { raw, headers: { 'linear-signature': 'sha256=' + crypto.createHmac('sha256', LINEAR).update(raw).digest('hex') } })).status, 401)
  assert.equal((await linearHook('a', { ...comment(), webhookTimestamp: Date.now() - 5 * 60e3 })).status, 401)
  const { webhookTimestamp, ...noTs } = comment()
  assert.equal((await linearHook('a', noTs)).status, 401)
  // The GitHub secret does not open the Linear route, and vice versa.
  assert.equal((await linearHook('a', comment(), { secret: SECRET })).status, 401)
  assert.equal((await linearHook('off', comment())).status, 404)
  assert.equal((await events('a', { body: { contains: 'never' } })).length, 0)
})

test('peers: a Linear delivery is copied to /webhook/linear with its own headers, even when its timestamp is old by then', async () => {
  await api('a', '/api/peers', { method: 'PUT', body: JSON.stringify({ name: 'b', url: nodes.b.base }) })
  try {
    const p = comment({ id: 'c-peer', body: '/bot from linear' })
    assert.equal((await linearHook('a', p, { delivery: 'L-peer' })).status, 200)
    const end = Date.now() + 3000
    let got
    while (!(got = (await events('b')).find(e => e.comment_id === 'c-peer')) && Date.now() < end) await new Promise(r => setTimeout(r, 25))
    assert.ok(got, 'copy arrived at b')
    assert.equal(got.delivery_id, 'L-peer')
    assert.ok(nodes.b.logs.some(l => /webhook linear:Comment\.created linear:ENG#123 delivery=L-peer stored \(forwarded, hop 1\)/.test(l)))
    // A copy is accepted after the 60 s replay window (it may sit in the outbox), but only with a valid peer signature.
    const { peerSignature } = await import('./server.mjs')
    const old = { ...comment({ id: 'c-old' }), webhookTimestamp: Date.now() - 10 * 60e3 }
    const raw = JSON.stringify(old)
    const hop = { 'x-issue-channel-hop': '1', 'x-issue-channel-signature': peerSignature(SECRET, { delivery: 'L-old', event: 'Comment', hop: 1 }, Buffer.from(raw)) }
    assert.equal((await linearHook('b', old, { delivery: 'L-old', raw, headers: hop })).status, 200)
    assert.equal((await linearHook('b', old, { delivery: 'L-old2', raw, headers: { 'x-issue-channel-hop': '1' } })).status, 401)
  } finally {
    await api('a', '/api/peers', { method: 'DELETE', body: JSON.stringify({ name: 'b' }) })
  }
})
