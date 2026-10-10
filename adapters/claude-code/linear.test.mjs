// Integration test: a Linear issue through the real server, the Claude Code channel, and a fake Linear GraphQL API.
import { fileURLToPath } from 'node:url'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { until, sleep, startServer } from '../testkit.mjs'

let t, linear, calls, refreshes, credsFile
const entry = fileURLToPath(new URL('./channel.mjs', import.meta.url))

// Fake api.linear.app: records every GraphQL call; /oauth/token refreshes.
before(async () => {
  t = await startServer()
  calls = []; refreshes = 0
  linear = http.createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (req.url === '/oauth/token') {
      refreshes++
      const f = new URLSearchParams(raw)
      assert.equal(f.get('grant_type'), 'refresh_token')
      return json(200, { access_token: 'fresh-token', refresh_token: 'rotated-refresh', expires_in: 86400 })
    }
    const { query, variables } = JSON.parse(raw)
    const auth = req.headers.authorization
    calls.push({ query, variables, auth })
    if (auth === 'Bearer stale-token') return json(401, { errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }] })
    if (query.includes('issue(id:')) return json(200, { data: { issue: { id: `uuid-${variables.id}` } } })
    if (query.includes('commentCreate')) return json(200, { data: { commentCreate: { success: true, comment: { id: crypto.randomUUID(), url: 'https://linear.app/x/issue/ENG-7#c' } } } })
    if (query.includes('reactionCreate') && variables.input.commentId === 'deleted-comment') return json(200, { errors: [{ message: 'invalid entity' }] })
    if (query.includes('reactionDelete') && variables.id === 'r-gone') return json(200, { errors: [{ message: 'Entity not found: Reaction' }] })
    if (query.includes('reactionCreate')) return json(200, { data: { reactionCreate: { success: true, reaction: { id: `r-${variables.input.emoji}-${calls.length}` } } } })
    if (query.includes('reactionDelete')) return json(200, { data: { reactionDelete: { success: true } } })
    if (query.includes('commentResolve')) return json(200, { data: { commentResolve: { success: true } } })
    if (query.includes('viewer')) return json(200, { data: { viewer: { id: 'app-user', name: 'bot', email: 'bot@example.com' } } })
    json(400, { errors: [{ message: `unexpected query ${query}` }] })
  })
  await new Promise(r => linear.listen(0, '127.0.0.1', r))
  credsFile = path.join(t.stateDir, 'linear.env')
})
after(() => { linear.close(); t.close() })

const start = (creds, env = {}) => {
  fs.writeFileSync(credsFile, Object.entries(creds).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 })
  const base = `http://127.0.0.1:${linear.address().port}`
  return t.start(entry, { CLAUDE_CODE_SESSION_ID: crypto.randomUUID(), ISSUECHAN_LINEAR_ENV_FILE: credsFile,
    LINEAR_API_URL: `${base}/graphql`, LINEAR_OAUTH_TOKEN_URL: `${base}/oauth/token`, ...env })
}
const ops = name => calls.filter(c => c.query.includes(name))

test('Linear: /bot in a thread is delivered, gets 👀, the reply goes into that thread, done swaps 👀 for ✅', async () => {
  const c = await start({ LINEAR_API_KEY: 'lin_api_test', LINEAR_ALLOWED_AUTHORS: 'me@example.com' })
  try {
    assert.match(await c.call('issue_subscribe', { repo: 'linear:ENG', issue: 7 }), /subscribed to linear:ENG#7 .*@me@example\.com/)
    await t.linearComment(7, 'some context first')
    await t.linearComment(7, 'a stranger', { email: 'other@example.com' })
    const cid = await t.linearComment(7, '/bot please answer here', { parentId: 'root-1' })
    assert.ok(await until(() => c.got.length === 1), 'delivered')
    const d = c.got[0]
    assert.match(d.content, /^Linear issue ENG-7 "Linear T": \/bot from @me@example\.com \(in the thread of comment root-1; issue_reply answers in that thread\)/)
    assert.match(d.content, /some context first/)
    assert.doesNotMatch(d.content, /a stranger/, 'only allowlisted authors')
    assert.deepEqual([d.meta.repo, d.meta.issue, d.meta.trigger_comment], ['linear:ENG', '7', cid])
    assert.ok(await until(() => ops('reactionCreate').length === 1))
    assert.deepEqual(ops('reactionCreate')[0].variables.input, { commentId: cid, emoji: 'eyes' })
    assert.equal(ops('reactionCreate')[0].auth, 'lin_api_test', 'a personal API key goes in as-is')

    const out = await c.call('issue_reply', { repo: 'linear:ENG', issue: 7, summary: 'Answered', body: 'The full answer.' })
    const create = ops('commentCreate')[0].variables.input
    assert.deepEqual([create.issueId, create.parentId], ['uuid-ENG-7', 'root-1'], 'reply in the thread root')
    assert.match(create.body, /^🤖 cc:[0-9a-f]{8} · Answered\n\n\+\+\+ Full reply\n\nThe full answer\.\n\n\+\+\+\n\n\[\/\/\]: # \(issue-channel:bot\)\n$/)
    assert.match(out, /https:\/\/linear\.app\/x\/issue\/ENG-7#c\ncomment .*: removed eyes, added white_check_mark/)
    assert.equal(ops('reactionDelete')[0].variables.id, 'r-eyes-' + (calls.indexOf(ops('reactionCreate')[0]) + 1))
    assert.deepEqual(ops('reactionCreate').at(-1).variables.input, { commentId: cid, emoji: 'white_check_mark' })

    // The app's own reply comes back as a webhook with botActor: never buffered, never a trigger.
    await t.linearComment(7, '🤖 /bot looks like a trigger', { botActor: { id: 'app', name: 'issue-channel' } })
    // Acting as a user, the agent's reply has an allowlisted author: the invisible marker keeps it out.
    await t.linearComment(7, '/bot 🤖 my own reply posted as the user\n\n[//]: # (issue-channel:bot)\n')
    const top = await t.linearComment(7, '/bot top-level now')
    assert.ok(await until(() => c.got.length === 2))
    assert.doesNotMatch(c.got[1].content, /looks like a trigger/)
    assert.doesNotMatch(c.got[1].content, /my own reply posted as the user/)
    assert.doesNotMatch(c.got[1].content, /in the thread of/)
    calls.length = 0
    await c.call('issue_reply', { repo: 'linear:ENG', issue: 7, summary: 'Top', body: 'x', done: false })
    assert.equal(ops('commentCreate')[0].variables.input.parentId, top, 'a top-level /bot gets a reply in its own thread')
  } finally { await c.close() }
})

test('Linear: an expired OAuth token is refreshed once and saved; resolve mode resolves the thread', async () => {
  const c = await start({ LINEAR_ACCESS_TOKEN: 'stale-token', LINEAR_REFRESH_TOKEN: 'r1', LINEAR_CLIENT_ID: 'cid', LINEAR_ALLOWED_AUTHORS: 'me@example.com' },
    { ISSUECHAN_LINEAR_DONE: 'resolve', ISSUECHAN_LINEAR_REACTION: '' })
  try {
    calls.length = 0
    await c.call('issue_subscribe', { repo: 'linear:ENG', issue: 8 })
    const cid = await t.linearComment(8, '/bot resolve me', { parentId: 'root-8' })
    assert.ok(await until(() => c.got.length === 1))
    await sleep(200)
    assert.equal(ops('reactionCreate').length, 0, 'no 👀 when disabled')
    const out = await c.call('issue_done', { repo: 'linear:ENG', issue: 8, comment_ids: [cid] })
    assert.match(out, /resolved the thread/)
    assert.equal(ops('commentResolve')[0].variables.id, 'root-8')
    assert.equal(ops('reactionCreate').length, 0, 'resolve mode adds no ✅')
  } finally { await c.close() }
  // The stale token got a 401, was refreshed with the refresh token, and the new pair was written back (0600).
  assert.equal(refreshes, 1)
  const saved = fs.readFileSync(credsFile, 'utf8')
  assert.match(saved, /LINEAR_ACCESS_TOKEN=fresh-token/)
  assert.match(saved, /LINEAR_REFRESH_TOKEN=rotated-refresh/)
  assert.match(saved, /LINEAR_ALLOWED_AUTHORS=me@example\.com/, 'other settings kept')
  assert.equal(fs.statSync(credsFile).mode & 0o777, 0o600)
  assert.ok(calls.some(x => x.auth === 'Bearer fresh-token'))
})

test('Linear: done on a comment deleted meanwhile reports it as gone, not as errors', async () => {
  const c = await start({ LINEAR_API_KEY: 'k', LINEAR_ALLOWED_AUTHORS: 'me@example.com' }, { ISSUECHAN_LINEAR_REACTION: '' })
  try {
    assert.equal(await c.call('issue_done', { repo: 'linear:ENG', issue: 10, comment_ids: ['deleted-comment'] }), 'comment deleted-comment: gone (deleted), skipped')
  } finally { await c.close() }
})

test('Linear: subscribing without an allowlist explains what to set', async () => {
  const c = await start({ LINEAR_API_KEY: 'k' })
  try {
    assert.match(await c.call('issue_subscribe', { repo: 'linear:ENG', issue: 9 }), /no Linear allowlist: set LINEAR_ALLOWED_AUTHORS/)
    assert.match(await c.call('issue_subscribe', { repo: 'linear:eng-x', issue: 9 }), /repo must be owner\/name \(GitHub\) or linear:<TEAM>/)
  } finally { await c.close() }
})
