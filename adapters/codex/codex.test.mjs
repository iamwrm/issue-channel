// Integration tests: the Codex entry (mcp.mjs) over MCP stdio against the real server (in-memory db)
// and a fake Codex app-server (WebSocket on a unix socket). GitHub is never called.
import { fileURLToPath } from 'node:url'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { REPO, until, startServer } from '../testkit.mjs'

const ENTRY = fileURLToPath(new URL('./mcp.mjs', import.meta.url))
let t, sockDir, sock, httpServer
const calls = [] // JSON-RPC requests the fake app-server received
const replies = [] // client responses to the fake app-server's own requests
const threads = new Map() // loaded threads: id -> cwd
let conn // the latest client connection

before(async () => {
  t = await startServer()
  sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issuechan-codex-'))
  sock = path.join(sockDir, 'app-server.sock')
  httpServer = http.createServer()
  const wss = new WebSocketServer({ server: httpServer })
  wss.on('connection', ws => (conn = ws).on('message', data => {
    const m = JSON.parse(String(data))
    if (m.id == null) return
    if (!m.method) return replies.push(m)
    calls.push(m)
    const result = m.method === 'thread/resume' ? { thread: { id: m.params.threadId } }
      : m.method === 'turn/start' ? { turn: { id: `turn-${calls.length}` } }
      : m.method === 'thread/loaded/list' ? { data: [...threads.keys()], nextCursor: null }
      : m.method === 'thread/read' ? { thread: { id: m.params.threadId, cwd: threads.get(m.params.threadId) } } : {}
    ws.send(JSON.stringify({ id: m.id, result }))
  }))
  await new Promise(r => httpServer.listen(sock, r))
})
after(() => {
  t.close()
  httpServer.close()
  fs.rmSync(sockDir, { recursive: true, force: true })
})

test('binds to the thread from the first tool call and delivers /bot as turn/start on that thread', async () => {
  const c = await t.start(ENTRY, { ISSUECHAN_CODEX_SOCK: sock })
  try {
    assert.equal(c.client.getServerCapabilities().experimental, undefined, 'no Claude channel capability')
    assert.match(c.client.getInstructions(), /arrives as a user message/)
    const thread = '01a12106-2f88-7392-a011-8d0336ca01c8'
    threads.set(thread, '/')
    assert.match(await c.call('issue_subscribe', { repo: REPO, issue: 1, session: 'cx' }, { threadId: thread }), /subscribed/)
    assert.ok(fs.existsSync(path.join(t.stateDir, `codex-${thread}.json`)), 'state is saved under codex-<thread id>')

    const cid = await t.comment(1, '/bot hello codex')
    assert.ok(await until(() => calls.some(m => m.method === 'turn/start')), 'turn/start reached the app-server')
    const methods = calls.map(m => m.method)
    assert.deepEqual(methods, ['initialize', 'thread/loaded/list', 'thread/resume', 'turn/start'])
    const turn = calls.find(m => m.method === 'turn/start')
    assert.equal(turn.params.threadId, thread)
    assert.match(turn.params.input[0].text, new RegExp(`/bot from @me[\\s\\S]*comment ${cid}[\\s\\S]*/bot hello codex`))

    await t.comment(1, '/bot second')
    assert.ok(await until(() => calls.filter(m => m.method === 'turn/start').length === 2))
    assert.equal(calls.filter(m => m.method === 'thread/resume').length, 1, 'the thread is joined once per connection')
  } finally { await c.close() }
})

test('a tool call without a thread id does not bind', async () => {
  const c = await t.start(ENTRY, { ISSUECHAN_CODEX_SOCK: sock })
  try {
    await c.call('issue_subscriptions', {}, { threadId: '../etc' })
    await c.call('issue_subscribe', { repo: REPO, issue: 2 })
    assert.equal(fs.readdirSync(t.stateDir).filter(f => /^codex-.*\.json$/.test(f)).length, 1, 'only the first test\'s state file')
  } finally { await c.close() }
})

test('a /bot is not lost while the app-server is unreachable, and a long symlinked socket path works', async () => {
  // Like `codex app-server --listen unix://PATH`: PATH is a symlink, here one longer than the
  // unix socket path limit, and it does not exist yet when the /bot arrives.
  const long = path.join(sockDir, 'x'.repeat(Math.max(1, 120 - sockDir.length)), 'as.sock')
  fs.mkdirSync(path.dirname(long), { recursive: true })
  const c = await t.start(ENTRY, { ISSUECHAN_CODEX_SOCK: long, ISSUECHAN_CODEX_RETRY_MS: '' })
  try {
    const thread = '01a12106-0000-7000-8000-000000000003'
    threads.set(thread, '/')
    await c.call('issue_subscribe', { repo: REPO, issue: 3 }, { threadId: thread })
    const before = calls.length
    await t.comment(3, '/bot sent while codex is down')
    await new Promise(r => setTimeout(r, 1500))
    assert.equal(calls.length, before, 'nothing reached the app-server yet')
    fs.symlinkSync(sock, long)
    const delivered = () => calls.slice(before).find(m => m.method === 'turn/start' && m.params.threadId === thread)
    assert.ok(await until(delivered, 10000), 'delivered once the app-server is reachable')
    assert.match(delivered().params.input[0].text, /sent while codex is down/)
  } finally { await c.close() }
})

test('server requests (approvals) are left for the UI client, not declined', async () => {
  const c = await t.start(ENTRY, { ISSUECHAN_CODEX_SOCK: sock })
  try {
    const thread = '01a12106-0000-7000-8000-000000000005'
    threads.set(thread, '/')
    await c.call('issue_subscribe', { repo: REPO, issue: 5 }, { threadId: thread })
    const before = calls.length
    await t.comment(5, '/bot run something')
    assert.ok(await until(() => calls.slice(before).some(m => m.method === 'turn/start')))
    // Like the app-server: an approval goes to every client on the thread, and the first answer wins.
    conn.send(JSON.stringify({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: thread } }))
    await new Promise(r => setTimeout(r, 500))
    assert.deepEqual(replies.filter(m => m.id === 'approval-1'), [], 'issuechan did not answer the approval')
  } finally { await c.close() }
})

test('without ISSUECHAN_CODEX_SOCK it uses the managed daemon socket under ~/.codex', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'issuechan-home-'))
  try {
    fs.mkdirSync(path.join(home, '.codex/app-server-control'), { recursive: true })
    fs.symlinkSync(sock, path.join(home, '.codex/app-server-control/app-server-control.sock'))
    const c = await t.start(ENTRY, { HOME: home })
    try {
      const thread = '01a12106-0000-7000-8000-000000000006'
      threads.set(thread, '/')
      await c.call('issue_subscribe', { repo: REPO, issue: 6 }, { threadId: thread })
      await t.comment(6, '/bot via the daemon')
      assert.ok(await until(() => calls.some(m => m.method === 'turn/start' && m.params.threadId === thread)))
    } finally { await c.close() }
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

// A saved subscription for `thread`, as an earlier issuechan process bound to it would have left it.
async function saveSub(thread, issue) {
  const { seq } = await t.api('GET', '/api/cursor')
  fs.writeFileSync(path.join(t.stateDir, `codex-${thread}.json`),
    JSON.stringify({ session: `s${issue}`, subs: { [`${REPO}#${issue}`]: { repo: REPO, issue, flushed: seq, open: [] } } }))
}

test('after an app-server restart it binds to its loaded thread and resumes without a tool call', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issuechan-cwd-'))
  const thread = '01a12106-0000-7000-8000-000000000007'
  threads.clear()
  threads.set(thread, dir)
  threads.set('01a12106-0000-7000-8000-0000000000ff', os.tmpdir()) // another project's thread
  await saveSub(thread, 7)
  const c = await t.start(ENTRY, { ISSUECHAN_CODEX_SOCK: sock }, { cwd: dir })
  try {
    assert.ok(await until(() => fs.existsSync(path.join(t.stateDir, 'codex-claims', thread))), 'claimed the thread')
    let registered = []
    for (const end = Date.now() + 5000; Date.now() < end && !registered.includes('s7'); await new Promise(r => setTimeout(r, 100))) registered = await t.registered(7)
    assert.deepEqual(registered, ['s7'], 'resumed the saved subscription')
    await t.comment(7, '/bot after restart')
    assert.ok(await until(() => calls.some(m => m.method === 'turn/start' && m.params.threadId === thread && /after restart/.test(m.params.input[0].text))))
  } finally { await c.close(); threads.clear(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('it does not guess between two unclaimed threads in the same cwd, and skips claimed ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issuechan-cwd-'))
  const a = '01a12106-0000-7000-8000-00000000000a', b = '01a12106-0000-7000-8000-00000000000b'
  threads.clear()
  threads.set(a, dir)
  threads.set(b, dir)
  await saveSub(b, 8)
  const env = { ISSUECHAN_CODEX_SOCK: sock, ISSUECHAN_CODEX_BIND_MS: '' }
  try {
    let c = await t.start(ENTRY, env, { cwd: dir })
    await new Promise(r => setTimeout(r, 1000))
    await c.close()
    assert.ok(!fs.existsSync(path.join(t.stateDir, 'codex-claims', b)), 'ambiguous: not bound')
    assert.deepEqual(await t.registered(8), [])

    // `a` is held by a live process (this test runner), so `b` is the only candidate left.
    fs.mkdirSync(path.join(t.stateDir, 'codex-claims'), { recursive: true })
    fs.writeFileSync(path.join(t.stateDir, 'codex-claims', a), String(process.pid))
    c = await t.start(ENTRY, env, { cwd: dir })
    try {
      assert.ok(await until(() => fs.existsSync(path.join(t.stateDir, 'codex-claims', b))), 'bound to b')
    } finally { await c.close() }
  } finally { threads.clear(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a thread that is not loaded in the app-server is not resumed; the /bot waits until a UI loads it', async () => {
  const c = await t.start(ENTRY, { ISSUECHAN_CODEX_SOCK: sock, ISSUECHAN_CODEX_RETRY_MS: '' })
  const thread = '01a12106-0000-7000-8000-000000000009'
  try {
    await c.call('issue_subscribe', { repo: REPO, issue: 9 }, { threadId: thread })
    const before = calls.length
    await t.comment(9, '/bot while nobody has the thread open')
    await new Promise(r => setTimeout(r, 1500))
    assert.ok(!calls.slice(before).some(m => m.params?.threadId === thread), 'no thread/resume or turn/start yet')
    threads.set(thread, '/')
    assert.ok(await until(() => calls.slice(before).some(m => m.method === 'turn/start' && m.params.threadId === thread), 10000), 'delivered once loaded')
  } finally { await c.close(); threads.delete(thread) }
})
