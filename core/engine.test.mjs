import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createIssueEngine, ISSUE_TOOLS } from './engine.mjs'
import { BOT_MARKER, LINEAR_MARKER } from './lib.mjs'

const repo = 'me/project'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, ms = 4500) {
  const end = Date.now() + ms
  while (!fn()) { if (Date.now() >= end) assert.fail('condition timed out'); await pause(10) }
}
const event = (seq, id, body, extra = {}) => ({ seq, repo, issue: 1, event: 'issue_comment',
  action: 'created', comment_id: id, author: 'me', body, title: 'Title', ...extra })
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

// In-process fake channel service: no harness, model, GitHub CLI or external API.
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-engine-'))
  const requests = [], events = [], registered = new Set(), deliveries = [], statuses = [], engines = []
  let queryFail = 0, registerFail = 0, queryGate, cursorGate
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : undefined
    requests.push({ method: req.method, url: req.url, body })
    const json = (status, value) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) } }
    if (req.url === '/api/cursor') {
      if (cursorGate) await cursorGate.promise
      return json(200, { seq: events.at(-1)?.seq ?? 0 })
    }
    if (req.url === '/api/subscriptions' && req.method === 'PUT') {
      if (registerFail-- > 0) return json(503, { error: 'register unavailable' })
      registered.add(JSON.stringify(body)); return json(200, {})
    }
    if (req.url === '/api/subscriptions' && req.method === 'DELETE') {
      registered.delete(JSON.stringify(body)); return json(200, {})
    }
    if (req.url.startsWith('/api/subscriptions?')) return json(200, { subscriptions: [{ session: 'other' }] })
    if (req.url === '/api/events/query') {
      if (queryGate) await queryGate.promise
      if (queryFail-- > 0) return json(503, { error: 'query unavailable' })
      await pause(15)
      const found = events.filter(ev => ev.seq > body.since && ev.repo === body.filter.repo && ev.issue === body.filter.issue).slice(0, body.limit)
      return json(200, { events: found, next: events.at(-1)?.seq ?? body.since })
    }
    json(404, {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const env = { ISSUECHAN_URL: `http://127.0.0.1:${server.address().port}`, ISSUECHAN_API_KEY: 'key',
    ISSUECHAN_REACTION: '', ISSUECHAN_DONE_REACTION: '', ISSUECHAN_LINEAR_REACTION: '', ISSUECHAN_LINEAR_DONE_REACTION: '',
    ISSUECHAN_LINEAR_ALLOWED: 'me', ...options.env }
  function make(extra = {}) {
    const engine = createIssueEngine({ agent: { agent: 'pi', id: 'safe.id_1' }, stateDir: dir, env,
      deliver: async d => { deliveries.push(d) }, onStatus: s => statuses.push(s), ...extra })
    engines.push(engine); return engine
  }
  t.after(async () => {
    for (const engine of engines) await engine.stop()
    queryGate?.resolve(); cursorGate?.resolve()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { dir, env, requests, events, registered, deliveries, statuses, make,
    file: path.join(dir, 'pi-safe.id_1.json'),
    set queryFail(n) { queryFail = n }, set registerFail(n) { registerFail = n },
    set queryGate(g) { queryGate = g }, set cursorGate(g) { cursorGate = g } }
}
const saved = (overrides = {}) => ({ session: 'saved', subs: { [`${repo}#1`]: {
  repo, issue: 1, flushed: 0, open: [], ...overrides } } })
const resultText = r => r.content[0].text
async function subscribe(engine, mode) {
  const r = await engine.callTool('issue_subscribe', { repo, issue: 1, ...(mode ? { mode } : {}) })
  assert.notEqual(r.isError, true, resultText(r))
  return r
}

test('API schemas, explicit identity/session/state directory, safe filename and positive refs', async t => {
  const f = await fixture(t, { env: { ISSUECHAN_AGENT_ID: 'cc:wrong', ISSUECHAN_SESSION: 'env', ISSUECHAN_STATE_DIR: '/invalid' } })
  assert.equal(ISSUE_TOOLS.length, 5)
  assert.deepEqual(ISSUE_TOOLS[0].inputSchema.properties.mode.enum, ['bot', 'updates'])
  const e = f.make({ session: 'explicit' })
  assert.deepEqual(Object.keys(e).sort(), ['callTool', 'getStatus', 'start', 'stop'])
  await e.start()
  for (const args of [{ repo, issue: 0 }, { repo, issue: -1 }, { repo, issue: 1.5 }, { repo: '../x', issue: 1 },
    { repo, issue: 1, mode: 'all' }, { repo, issue: 1, session: '../escape' }]) {
    assert.equal((await e.callTool('issue_subscribe', args)).isError, true)
  }
  assert.equal((await e.callTool('issue_unsubscribe', { repo, issue: 0 })).isError, true)
  assert.equal((await e.callTool('made_up', {})).isError, true)
  assert.equal(f.requests.length, 0)
  assert.match(resultText(await subscribe(e)), /mode=bot connected=false/)
  assert.ok(fs.existsSync(f.file))
  assert.equal(fs.existsSync(path.join(f.dir, 'cc-wrong.json')), false)
  assert.equal(JSON.parse(fs.readFileSync(f.file)).session, 'explicit')
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600)
  assert.throws(() => f.make({ agent: { agent: 'pi', id: '../escape' } }), /invalid agent/)
})

test('malformed state fails closed, including valid JSON with invalid structure', async t => {
  const f = await fixture(t)
  for (const value of ['{broken', '{"subs":[]}', JSON.stringify(saved({ flushed: -1 })), JSON.stringify(saved({ mode: 'all' }))]) {
    fs.writeFileSync(f.file, value)
    const e = f.make()
    await assert.rejects(e.start(), /malformed issue-channel state/)
    assert.equal((await e.callTool('issue_subscribe', { repo, issue: 1 })).isError, true)
    assert.match(e.getStatus().error, /malformed/)
    assert.equal(fs.readFileSync(f.file, 'utf8'), value)
    await e.stop()
  }
  assert.equal(f.requests.length, 0)
})

test('async restore exposes disconnected saved state, respects saved/explicit sessions and aborts replay', async t => {
  const f = await fixture(t)
  fs.writeFileSync(f.file, JSON.stringify(saved({ open: [11], roots: {} })))
  const gate = deferred(); f.queryGate = gate
  const e = f.make()
  await e.start()
  assert.deepEqual(e.getStatus(), { session: 'saved', subscriptions: [{ repo, issue: 1, mode: 'bot', connected: false, cursor: 0, openRequests: [11] }] })
  await until(() => f.requests.some(r => r.url === '/api/events/query'))
  const before = fs.readFileSync(f.file, 'utf8'), callbacks = f.statuses.length, at = Date.now()
  await e.stop()
  assert.ok(Date.now() - at < 1000)
  gate.resolve(); await pause(100)
  assert.equal(f.statuses.length, callbacks)
  assert.equal(fs.readFileSync(f.file, 'utf8'), before)
  assert.equal(f.requests.filter(r => r.method === 'PUT').length, 0)
  f.queryGate = undefined
  const explicit = f.make({ session: 'new' })
  await explicit.start()
  assert.equal(explicit.getStatus().session, 'new')
  await until(() => explicit.getStatus().subscriptions[0]?.connected)
  assert.ok([...f.registered].some(s => JSON.parse(s).session === 'new'))
})

test('registration/query errors are unhealthy and recover; stop unregisters only runtime registrations', async t => {
  const f = await fixture(t)
  const unrelated = JSON.stringify({ repo, issue: 99, session: 'other' })
  f.registered.add(unrelated)
  f.registerFail = 1
  const e = f.make()
  const failed = await e.callTool('issue_subscribe', { repo, issue: 1 })
  assert.equal(failed.isError, true)
  assert.equal(fs.existsSync(f.file), false)
  assert.match(e.getStatus().error, /register unavailable/)
  f.queryFail = 1
  await subscribe(e)
  assert.equal(e.getStatus().subscriptions[0].connected, false)
  await until(() => /query unavailable/.test(e.getStatus().error ?? ''))
  await until(() => e.getStatus().subscriptions[0].connected)
  assert.equal(e.getStatus().error, undefined)
  const before = fs.readFileSync(f.file, 'utf8')
  await e.stop(); await e.stop()
  assert.equal(fs.readFileSync(f.file, 'utf8'), before)
  assert.deepEqual([...f.registered], [unrelated])
  assert.equal(e.getStatus().subscriptions[0].connected, false)
  assert.equal((await e.callTool('issue_subscribe', { repo, issue: 2 })).isError, true)
})

test('auto-resume retries registration failure without forgetting durable subscriptions', async t => {
  const f = await fixture(t)
  fs.writeFileSync(f.file, JSON.stringify(saved()))
  f.registerFail = 1
  const e = f.make(); await e.start()
  await until(() => /register unavailable/.test(e.getStatus().error ?? ''))
  assert.equal(e.getStatus().subscriptions[0].connected, false)
  await until(() => e.getStatus().subscriptions[0].connected)
  assert.equal(e.getStatus().error, undefined)
  assert.equal(JSON.parse(fs.readFileSync(f.file)).session, 'saved')
})

test('serialized subscribe, mode changes, rename, unsubscribe and in-flight polls', async t => {
  const f = await fixture(t), e = f.make()
  const results = await Promise.all([subscribe(e), subscribe(e)])
  assert.ok(results.some(r => /already subscribed/.test(resultText(r))))
  assert.equal(f.requests.filter(r => r.method === 'PUT').length, 1)
  await e.callTool('issue_subscribe', { repo, issue: 1, session: 'renamed', mode: 'updates' })
  assert.deepEqual([...f.registered].map(s => JSON.parse(s).session), ['renamed'])
  assert.equal(JSON.parse(fs.readFileSync(f.file)).subs[`${repo}#1`].mode, 'updates')
  assert.match(resultText(await e.callTool('issue_subscriptions')), /mode=updates connected=/)
  const gate = deferred(); f.queryGate = gate
  await until(() => f.requests.filter(r => r.url === '/api/events/query').length >= 2)
  assert.match(resultText(await e.callTool('issue_unsubscribe', { repo, issue: 1 })), /unsubscribed/)
  f.events.push(event(1, 1, '/bot too late')); gate.resolve(); await pause(100)
  assert.equal(f.deliveries.length, 0)
  assert.equal(e.getStatus().subscriptions.length, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).subs, {})
})

test('delivery retry rolls back mutated buffers and never repeats accepted earlier batch events', async t => {
  const f = await fixture(t)
  let attempts = 0
  const accepted = []
  const e = f.make({ deliver: async d => {
    attempts++
    if (d.meta.seq === '4' && attempts === 2) throw new Error('inbox unavailable')
    accepted.push(d)
  } })
  await subscribe(e)
  f.events.push(event(1, 10, 'v1'), event(2, 11, '/bot'), event(3, 10, 'v2', { action: 'edited' }), event(4, 12, '/bot'))
  await until(() => /inbox unavailable/.test(e.getStatus().error ?? ''))
  const interim = JSON.parse(fs.readFileSync(f.file)).subs[`${repo}#1`]
  assert.equal(interim.flushed, 2)
  assert.deepEqual(interim.open, [11])
  await until(() => accepted.length === 2)
  assert.equal(attempts, 3)
  assert.deepEqual(accepted.map(d => d.meta.seq), ['2', '4'])
  assert.match(accepted[1].content, /- v1\n\+ v2/)
  assert.deepEqual(e.getStatus().subscriptions[0].openRequests, [11, 12])
  assert.equal(JSON.parse(fs.readFileSync(f.file)).subs[`${repo}#1`].flushed, 4)
})

test('updates mode emits comments, edits, body and deletes; filters bot/strangers, keeps commands real', async t => {
  const f = await fixture(t), e = f.make()
  await subscribe(e, 'updates')
  f.events.push(event(1, 10, 'plain'), event(2, 10, 'changed', { action: 'edited' }),
    event(3, 20, `reply ${BOT_MARKER}`), event(4, 21, `reply ${LINEAR_MARKER}`),
    event(5, 22, '/bot', { bot_actor: { id: 'app' } }), event(6, 23, '/bot', { author: 'eve' }),
    event(7, 24, 'body', { event: 'issues', action: 'edited' }), event(8, 10, 'changed', { action: 'deleted' }),
    event(9, 25, '/bot'), event(10, 25, '/bot modified', { action: 'edited' }), event(11, 25, '/bot modified', { action: 'edited' }))
  await until(() => e.getStatus().subscriptions[0].cursor === 11)
  assert.deepEqual(f.deliveries.map(d => d.meta.seq), ['1', '2', '7', '8', '9', '10'])
  assert.deepEqual(f.deliveries.map(d => d.meta.is_request), ['false', 'false', 'false', 'false', 'true', 'false'])
  assert.ok(f.deliveries.every(d => d.meta.mode === 'updates'))
  assert.equal(f.deliveries[0].meta.trigger_comment, undefined)
  assert.match(f.deliveries[0].content, /issue update/)
  assert.match(f.deliveries[1].content, /- plain\n\+ changed/)
  assert.match(f.deliveries[3].content, /was deleted/)
  assert.deepEqual(e.getStatus().subscriptions[0].openRequests, [25])
})

test('default bot mode waits, routes targeted commands and avoids an edited /bot retrigger', async t => {
  const f = await fixture(t), e = f.make()
  await subscribe(e)
  f.events.push(event(1, 10, 'context'))
  await until(() => e.getStatus().subscriptions[0].cursor === 1)
  assert.equal(f.deliveries.length, 0)
  f.events.push(event(2, 11, '/bot other'), event(3, 12, '/bot unknown'))
  await until(() => f.deliveries.length === 1)
  assert.equal(f.deliveries[0].meta.seq, '3')
  assert.doesNotMatch(f.deliveries[0].content, /context/)
  assert.deepEqual(e.getStatus().subscriptions[0].openRequests, [12])
  f.events.push(event(4, 12, '/bot edit', { action: 'edited' }))
  await until(() => e.getStatus().subscriptions[0].cursor === 4)
  assert.equal(f.deliveries.length, 1)
})

test('Linear ordinary thread metadata and roots survive partial done and restart', async t => {
  const f = await fixture(t), e = f.make()
  assert.notEqual((await e.callTool('issue_subscribe', { repo: 'linear:ENG', issue: 1, mode: 'updates' })).isError, true)
  f.events.push(event(1, 'ordinary', 'hello', { repo: 'linear:ENG', parent_id: 'root' }),
    event(2, 'cmd1', '/bot', { repo: 'linear:ENG', parent_id: 'root1' }),
    event(3, 'cmd2', '/bot', { repo: 'linear:ENG', parent_id: 'root2' }))
  await until(() => f.deliveries.length === 3)
  assert.equal(f.deliveries[0].meta.reply_to, 'root')
  assert.equal(f.deliveries[0].meta.is_request, 'false')
  assert.equal(f.deliveries[1].meta.trigger_comment, 'cmd1')
  f.events.push(event(4, 'cmd2', '/bot edited', { repo: 'linear:ENG', action: 'edited' }))
  await until(() => f.deliveries.length === 4)
  assert.equal(f.deliveries[3].meta.reply_to, 'root2', 'edits without parent_id retain the known thread')
  assert.equal(f.deliveries[3].meta.is_request, 'false')
  const done = await e.callTool('issue_done', { repo: 'linear:ENG', issue: 1, comment_ids: ['cmd1'] })
  assert.notEqual(done.isError, true, resultText(done))
  const sub = JSON.parse(fs.readFileSync(f.file)).subs['linear:ENG#1']
  assert.deepEqual(sub.open, ['cmd2'])
  assert.deepEqual(sub.roots, { ordinary: 'root', cmd2: 'root2' })
  await e.stop()
  const resumed = f.make(); await resumed.start()
  await until(() => resumed.getStatus().subscriptions[0]?.connected)
  assert.deepEqual(resumed.getStatus().subscriptions[0].openRequests, ['cmd2'])
  assert.equal(resumed.getStatus().subscriptions[0].mode, 'updates')
  assert.equal(f.deliveries.length, 4, 'no delivered replay duplicates')
})

test('stop aborts a hung tool and late network results cannot mutate state or callback', async t => {
  const f = await fixture(t), gate = deferred(); f.cursorGate = gate
  const e = f.make(), pending = subscribe(e).catch(error => error)
  await until(() => f.requests.some(r => r.url === '/api/cursor'))
  const callbacks = f.statuses.length, at = Date.now()
  await e.stop(); assert.ok(Date.now() - at < 1000)
  await pending
  gate.resolve(); await pause(100)
  assert.equal(f.statuses.length, callbacks)
  assert.equal(fs.existsSync(f.file), false)
  assert.equal(f.requests.some(r => r.method === 'PUT'), false)
})

test('stop aborts hung inbox acceptance without advancing durable cursor/open or late callbacks', async t => {
  const f = await fixture(t), gate = deferred()
  let startedDelivery = false
  const e = f.make({ deliver: async () => { startedDelivery = true; await gate.promise } })
  await subscribe(e)
  f.events.push(event(1, 10, '/bot'))
  await until(() => startedDelivery)
  const before = fs.readFileSync(f.file, 'utf8'), callbacks = f.statuses.length, at = Date.now()
  await e.stop(); assert.ok(Date.now() - at < 1000)
  gate.resolve(); await pause(100)
  assert.equal(fs.readFileSync(f.file, 'utf8'), before)
  assert.equal(f.statuses.length, callbacks)
})

test('first poll is nonwaiting, readiness is immediate, later polls long-wait', async t => {
  const f = await fixture(t), e = f.make()
  await subscribe(e)
  assert.equal(e.getStatus().subscriptions[0].connected, false)
  await until(() => e.getStatus().subscriptions[0].connected, 1000)
  await until(() => f.requests.filter(r => r.body?.timeout !== undefined).length >= 2)
  assert.deepEqual(f.requests.filter(r => r.body?.timeout !== undefined).slice(0, 2).map(r => r.body.timeout), [0, 50])
})

test('unsubscribing a disconnected auto-restore cancels its retries and forgets only that subscription', async t => {
  const f = await fixture(t)
  fs.writeFileSync(f.file, JSON.stringify(saved()))
  f.registerFail = 5
  const e = f.make(); await e.start()
  await until(() => /register unavailable/.test(e.getStatus().error ?? ''))
  const puts = f.requests.filter(r => r.method === 'PUT').length
  const r = await e.callTool('issue_unsubscribe', { repo, issue: 1 })
  assert.match(resultText(r), /unsubscribed/)
  assert.deepEqual(e.getStatus().subscriptions, [])
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).subs, {})
  await pause(2150)
  assert.equal(f.requests.filter(r => r.method === 'PUT').length, puts)
})

test('stop aborts auto-resume backoff with no later callbacks or registration attempts', async t => {
  const f = await fixture(t)
  fs.writeFileSync(f.file, JSON.stringify(saved()))
  f.registerFail = 5
  const e = f.make(); await e.start()
  await until(() => /register unavailable/.test(e.getStatus().error ?? ''))
  const before = fs.readFileSync(f.file, 'utf8'), puts = f.requests.filter(r => r.method === 'PUT').length
  await e.stop()
  const statuses = f.statuses.length
  await pause(2150)
  assert.equal(f.requests.filter(r => r.method === 'PUT').length, puts)
  assert.equal(f.statuses.length, statuses)
  assert.equal(fs.readFileSync(f.file, 'utf8'), before)
})

test('stop is bounded even when fetch ignores abort, including unregister requests', async t => {
  const f = await fixture(t), e = f.make()
  await subscribe(e)
  await until(() => e.getStatus().subscriptions[0].connected)
  const original = globalThis.fetch
  globalThis.fetch = () => new Promise(() => {})
  try {
    const before = fs.readFileSync(f.file, 'utf8'), callbacks = f.statuses.length, at = Date.now()
    await e.stop()
    assert.ok(Date.now() - at < 1000)
    assert.equal(fs.readFileSync(f.file, 'utf8'), before)
    assert.equal(f.statuses.length, callbacks)
  } finally { globalThis.fetch = original }
})

test('partial GitHub done persists remaining requests and mode across restart without CLI calls', async t => {
  const f = await fixture(t), e = f.make()
  await subscribe(e, 'updates')
  f.events.push(event(1, 10, '/bot'), event(2, 11, '/bot'))
  await until(() => f.deliveries.length === 2)
  assert.notEqual((await e.callTool('issue_done', { repo, issue: 1, comment_ids: ['10'] })).isError, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).subs[`${repo}#1`].open, [11])
  await e.stop()
  const resumed = f.make(); await resumed.start()
  await until(() => resumed.getStatus().subscriptions[0]?.connected)
  assert.deepEqual(resumed.getStatus().subscriptions[0].openRequests, [11])
  assert.equal(resumed.getStatus().subscriptions[0].mode, 'updates')
})

test('state corruption after start is never overwritten by subscription mutations', async t => {
  const f = await fixture(t), e = f.make()
  await subscribe(e)
  fs.writeFileSync(f.file, '{corrupt')
  const r = await e.callTool('issue_subscribe', { repo, issue: 2 })
  assert.equal(r.isError, true)
  assert.match(e.getStatus().error, /malformed/)
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{corrupt')
})

test('/bot !no-compact is handled by code: never delivered here; the successor delivers its text natively', async t => {
  const f = await fixture(t), calls = []
  const e = f.make({ onNoCompact: r => { calls.push(r) } })
  await subscribe(e)
  f.events.push(event(1, 10, 'context'), event(2, 11, '/bot !no-compact nobody'))
  await until(() => e.getStatus().subscriptions[0].cursor === 2)
  assert.equal(calls.length, 0, 'an unknown name targets no session')
  f.events.push(event(3, 12, '/bot !no-compact\nwhat did we find?'))
  await until(() => calls.length === 1)
  assert.equal(calls[0].comment_id, 12)
  // While the swap runs, later /bot comments are held, unflushed.
  f.events.push(event(4, 13, '/bot are you there?'))
  await until(() => e.getStatus().subscriptions[0].cursor === 4)
  assert.equal(f.deliveries.length, 0)
  const state = JSON.parse(fs.readFileSync(f.file, 'utf8')).subs[`${repo}#1`]
  assert.equal(state.flushed, 2, 'the cursor stays before the command')
  assert.equal(state.resetBy, '12')
  // The swap: this process ends, the state file is handed over, the successor resumes from it.
  await e.stop()
  const succ = f.make({ onNoCompact: r => { calls.push(r) } })
  await succ.start()
  await until(() => f.deliveries.length === 2)
  assert.equal(calls.length, 1, 'the successor does not reset again')
  assert.equal(f.deliveries[0].meta.trigger_comment, '12')
  assert.match(f.deliveries[0].content, /what did we find\?/)
  assert.doesNotMatch(f.deliveries[0].content, /are you there/)
  assert.equal(f.deliveries[1].meta.trigger_comment, '13')
  const after = JSON.parse(fs.readFileSync(f.file, 'utf8')).subs[`${repo}#1`]
  assert.equal(after.resetBy, undefined)
  assert.deepEqual(after.open, [12, 13])
})

test('/bot !no-compact: no text means nothing to deliver; a failed swap or a hook that cannot run delivers normally', async t => {
  const f = await fixture(t), posted = [], calls = []
  const e = f.make({ onNoCompact: r => { calls.push(r) } })
  await subscribe(e)
  f.events.push(event(1, 10, '/bot !no-compact'))
  await until(() => calls.length === 1)
  await e.stop()
  const succ = f.make({ onNoCompact: r => { calls.push(r) } })
  await succ.start()
  await until(() => JSON.parse(fs.readFileSync(f.file, 'utf8')).subs[`${repo}#1`].flushed === 1)
  assert.equal(f.deliveries.length, 0)
  assert.equal(calls.length, 1)

  const g = await fixture(t), gcalls = []
  const e2 = g.make({ onNoCompact: r => { gcalls.push(r) } })
  await subscribe(e2)
  g.events.push(event(1, 20, '/bot !no-compact\nstatus?'), event(2, 21, '/bot later'))
  await until(() => e2.getStatus().subscriptions[0].cursor === 2)
  assert.equal(g.deliveries.length, 0)
  gcalls[0].onFailed()
  await until(() => g.deliveries.length === 1)
  assert.match(g.deliveries[0].content, /status\?[\s\S]*later/, 'held /bot delivered with everything before it')

  const h = await fixture(t)
  const e3 = h.make({ onNoCompact: () => { throw new Error('not in herdr') }, ghComment: async (...a) => { posted.push(a) } })
  await subscribe(e3)
  h.events.push(event(1, 30, '/bot !no-compact\nstatus?'))
  await until(() => h.deliveries.length === 1)
  assert.match(h.deliveries[0].content, /status\?/)
  assert.equal(posted.length, 1)
  assert.match(posted[0][2], /!no-compact failed: not in herdr/)
})

test('reply metadata comes only from adapter call context; old callers and schemas stay compatible', async t => {
  const f = await fixture(t), posted = []
  const e = f.make({ ghComment: async (...args) => { posted.push(args); return 'https://github.test/comment' } })
  const args = { repo, issue: 1, summary: 's', body: 'b', done: false,
    metadata: { provider: 'spoofed', model: 'spoofed', contextPercent: 99 } }
  const replyMetadata = { provider: 'p', model: 'm', thinkingLevel: 'high', contextPercent: 30, contextWindow: 1000000 }
  assert.equal(resultText(await e.callTool('issue_reply', args, { replyMetadata })), 'https://github.test/comment')
  assert.ok(posted[0][2].endsWith(`p/m:high 30%/1M\n\n${BOT_MARKER}\n`))
  assert.doesNotMatch(posted[0][2], /spoofed/)
  assert.equal(resultText(await e.callTool('issue_reply', args)), 'https://github.test/comment')
  assert.doesNotMatch(posted[1][2], /spoofed|30%/)
  assert.equal(ISSUE_TOOLS.find(t => t.name === 'issue_reply').inputSchema.properties.metadata, undefined)
})
