// Integration tests: channel.mjs over MCP stdio against the real server (in-memory db).
// GitHub is never called: reactions are disabled and no reply/done tools are used.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { openDb, createApp } from '../server/server.mjs'

const SECRET = 's'.repeat(40)
const KEY = 'k'.repeat(40)
const REPO = 'o/r'
let server, base, stateDir, nextComment = 1000, nextDelivery = 0

before(async () => {
  server = http.createServer(createApp({ db: openDb(':memory:'), webhookSecret: SECRET, apiKey: KEY, log: () => {} }))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issuechan-test-'))
})
after(() => {
  server.close()
  fs.rmSync(stateDir, { recursive: true, force: true })
})

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function comment(issue, body) {
  const id = ++nextComment
  const now = new Date().toISOString()
  const raw = JSON.stringify({
    action: 'created', repository: { full_name: REPO }, issue: { number: issue, title: 'T' },
    comment: { id, body, user: { login: 'me' }, created_at: now, updated_at: now }, sender: { login: 'me' },
  })
  const res = await fetch(`${base}/webhook/github`, {
    method: 'POST', body: raw,
    headers: {
      'x-github-event': 'issue_comment', 'x-github-delivery': `d-${++nextDelivery}`, 'content-type': 'application/json',
      'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex'),
    },
  })
  assert.ok(res.ok, `webhook ${res.status}`)
  return id
}

async function api(method, p) {
  const res = await fetch(`${base}${p}`, { method, headers: { authorization: `Bearer ${KEY}` } })
  return res.json()
}
const registered = async issue =>
  (await api('GET', `/api/subscriptions?repo=${encodeURIComponent(REPO)}&issue=${issue}`)).subscriptions.map(s => s.session).sort()

// Start channel.mjs as a Claude Code session with the given id; collects channel notifications.
async function start(sessionId) {
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  const got = []
  client.fallbackNotificationHandler = async n => {
    if (n.method === 'notifications/claude/channel') got.push({ at: Date.now(), ...n.params })
  }
  const transport = new StdioClientTransport({
    command: process.execPath, args: [new URL('./channel.mjs', import.meta.url).pathname], stderr: 'ignore',
    env: {
      PATH: process.env.PATH, ISSUECHAN_URL: base, ISSUECHAN_API_KEY: KEY, ISSUECHAN_STATE_DIR: stateDir,
      ISSUECHAN_ALLOWED_AUTHORS: 'me', ISSUECHAN_REACTION: '', ISSUECHAN_DONE_REACTION: '',
      ISSUECHAN_RESUME_DELAY_MS: '400', CLAUDE_CODE_SESSION_ID: sessionId,
    },
  })
  const t0 = Date.now()
  await client.connect(transport)
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text
  return { client, got, call, t0, close: () => client.close() }
}

async function until(fn, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (fn()) return true
  return false
}

test('no delivery after unsubscribe, even from a long poll already in flight', async () => {
  const c = await start(crypto.randomUUID())
  try {
    await c.call('issue_subscribe', { repo: REPO, issue: 1, session: 'a' })
    await comment(1, '/bot first')
    assert.ok(await until(() => c.got.length === 1), 'control: a /bot is delivered while subscribed')
    await sleep(300) // the next long poll is now waiting on the server
    assert.match(await c.call('issue_unsubscribe', { repo: REPO, issue: 1 }), /unsubscribed/)
    await comment(1, '/bot after unsubscribe')
    await sleep(1000)
    assert.equal(c.got.length, 1, 'nothing delivered after unsubscribe')
  } finally { await c.close() }
})

test('renaming the session moves the server registration', async () => {
  const c = await start(crypto.randomUUID())
  try {
    await c.call('issue_subscribe', { repo: REPO, issue: 2, session: 'old' })
    assert.deepEqual(await registered(2), ['old'])
    assert.match(await c.call('issue_subscribe', { repo: REPO, issue: 2, session: 'new' }), /already subscribed .* as session new/)
    assert.deepEqual(await registered(2), ['new'])
  } finally { await c.close() }
})

test('handoff resume: waits for initialized, delivers the backlog, takes the new name', async () => {
  const id = crypto.randomUUID()
  const { seq } = await api('GET', '/api/cursor')
  // What `session-fork handoff` copies: the parent's subscription, cursor and name.
  fs.writeFileSync(path.join(stateDir, `cc-${id}.json`), JSON.stringify({
    session: 'parent', subs: { [`${REPO}#3`]: { repo: REPO, issue: 3, flushed: seq, open: [] } },
  }))
  const cid = await comment(3, '/bot sent during the switch')
  const c = await start(id)
  try {
    assert.ok(await until(() => c.got.length === 1), 'the /bot posted during the switch is delivered')
    assert.ok(c.got[0].at - c.t0 >= 400, `first delivery waited for the resume delay (${c.got[0].at - c.t0} ms)`)
    assert.equal(c.got[0].meta.trigger_comment, String(cid))
    assert.deepEqual(await registered(3), ['parent'])
    await c.call('issue_subscribe', { repo: REPO, issue: 3, session: 'child' })
    assert.deepEqual(await registered(3), ['child'])
    await c.call('issue_unsubscribe', { repo: REPO, issue: 3 })
    assert.deepEqual(await registered(3), [], 'no orphaned registration is left')
  } finally { await c.close() }
})
