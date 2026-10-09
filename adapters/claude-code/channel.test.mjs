// Integration tests: the Claude Code entry (channel.mjs) over MCP stdio against the real server (in-memory db).
// GitHub is never called: reactions are disabled and no reply/done tools are used.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { REPO, sleep, until, startServer } from '../testkit.mjs'

let t
before(async () => { t = await startServer() })
after(() => t.close())

const comment = (...a) => t.comment(...a)
const api = (...a) => t.api(...a)
const registered = issue => t.registered(issue)
// Start channel.mjs as a Claude Code session with the given id; collects channel notifications.
const start = (sessionId, entry = new URL('./channel.mjs', import.meta.url).pathname) =>
  t.start(entry, { ISSUECHAN_RESUME_DELAY_MS: '400', CLAUDE_CODE_SESSION_ID: sessionId })

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
  fs.writeFileSync(path.join(t.stateDir, `cc-${id}.json`), JSON.stringify({
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

test('the old channel/channel.mjs path (what ~/.claude.json runs) still starts the channel', async () => {
  const c = await start(crypto.randomUUID(), new URL('../../channel/channel.mjs', import.meta.url).pathname)
  try {
    const caps = c.client.getServerCapabilities()
    assert.deepEqual(caps.experimental, { 'claude/channel': {} })
    assert.match(c.client.getInstructions(), /^issuechan connects this session to GitHub issues\. Messages arrive as <channel source="issuechan"/)
    await c.call('issue_subscribe', { repo: REPO, issue: 4 })
    const cid = await comment(4, '/bot via the old path')
    assert.ok(await until(() => c.got.length === 1), 'a /bot is delivered')
    assert.equal(c.got[0].meta.trigger_comment, String(cid))
  } finally { await c.close() }
})
