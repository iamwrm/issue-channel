// Integration tests: the Codex entry (mcp.mjs) over MCP stdio against the real server (in-memory db)
// and a fake Codex app-server (WebSocket on a unix socket). GitHub is never called.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { REPO, until, startServer } from '../testkit.mjs'

const ENTRY = new URL('./mcp.mjs', import.meta.url).pathname
let t, sockDir, sock, httpServer
const calls = [] // JSON-RPC requests the fake app-server received

before(async () => {
  t = await startServer()
  sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issuechan-codex-'))
  sock = path.join(sockDir, 'app-server.sock')
  httpServer = http.createServer()
  const wss = new WebSocketServer({ server: httpServer })
  wss.on('connection', ws => ws.on('message', data => {
    const m = JSON.parse(String(data))
    if (m.id == null) return
    calls.push(m)
    const result = m.method === 'thread/resume' ? { thread: { id: m.params.threadId } }
      : m.method === 'turn/start' ? { turn: { id: `turn-${calls.length}` } } : {}
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
    assert.match(await c.call('issue_subscribe', { repo: REPO, issue: 1, session: 'cx' }, { threadId: thread }), /subscribed/)
    assert.ok(fs.existsSync(path.join(t.stateDir, `codex-${thread}.json`)), 'state is saved under codex-<thread id>')

    const cid = await t.comment(1, '/bot hello codex')
    assert.ok(await until(() => calls.some(m => m.method === 'turn/start')), 'turn/start reached the app-server')
    const methods = calls.map(m => m.method)
    assert.deepEqual(methods, ['initialize', 'thread/resume', 'turn/start'])
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
    assert.equal(fs.readdirSync(t.stateDir).filter(f => f.startsWith('codex-')).length, 1, 'only the first test\'s state file')
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
