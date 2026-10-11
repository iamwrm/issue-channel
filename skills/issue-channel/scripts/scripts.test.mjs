// The skill's helper scripts: ref parsing, and linear.mjs against a fake Linear API.
import { fileURLToPath } from 'node:url'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { parseRef } from './backup-issue.mjs'

test('backup-issue parses GitHub and Linear refs', () => {
  assert.deepEqual(parseRef('iamwrm/mainbot#39'), { kind: 'github', owner: 'iamwrm', repo: 'mainbot', number: 39 })
  assert.deepEqual(parseRef('https://github.com/o/r.x/issues/7#issuecomment-1'), { kind: 'github', owner: 'o', repo: 'r.x', number: 7 })
  assert.deepEqual(parseRef('ENG-123'), { kind: 'linear', identifier: 'ENG-123' })
  assert.deepEqual(parseRef('linear:eng#5'), { kind: 'linear', identifier: 'ENG-5' })
  assert.deepEqual(parseRef('https://linear.app/ws/issue/REN-106/some-title'), { kind: 'linear', identifier: 'REN-106' })
  assert.equal(parseRef('nonsense'), null)
})

// As in a real team: two "started" states, In Review sorted after In Progress.
const STATES = [{ id: 's1', name: 'Done', type: 'completed', position: 3 }, { id: 's2', name: 'Todo', type: 'unstarted', position: 1 },
  { id: 's4', name: 'In Review', type: 'started', position: 1002 }, { id: 's3', name: 'In Progress', type: 'started', position: 2 }]
let api, calls, dir
before(async () => {
  calls = []
  api = http.createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const { query, variables } = JSON.parse(raw)
    calls.push({ query, variables })
    const data = query.includes('issue(id:') && !query.includes('team') ? { issue: { id: `uuid-${variables.id}` } }
      : query.includes('team { states') ? { issue: { id: 'uuid', team: { states: { nodes: STATES } } } }
      : query.includes('teams(filter') ? { teams: { nodes: variables.k === 'REN' ? [{ id: 'team-1', states: { nodes: STATES } }] : [] } }
      : query.includes('issueCreate') ? { issueCreate: { success: true, issue: { identifier: 'REN-9', url: 'https://linear.app/x/issue/REN-9', state: { name: 'In Progress' } } } }
      : query.includes('commentCreate') ? { commentCreate: { success: true, comment: { id: 'c1', url: 'u' } } }
      : query.includes('issueUpdate') ? { issueUpdate: { success: true, issue: { state: { name: 'Done' } } } }
      : query.includes('commentUpdate') ? { commentUpdate: { success: true, comment: { url: 'u2' } } }
      : query.includes('commentDelete') ? (variables.id === 'gone' ? null : { commentDelete: { success: true } })
      : {}
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data ? { data } : { errors: [{ message: 'Entity not found: Comment' }] }))
  })
  await new Promise(r => api.listen(0, '127.0.0.1', r))
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-'))
  fs.writeFileSync(path.join(dir, 'linear.env'), 'LINEAR_API_KEY=k\n')
})
after(() => { api.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const cli = (...args) => new Promise(resolve => execFile(process.execPath, [fileURLToPath(new URL('./linear.mjs', import.meta.url)), ...args], {
  env: { PATH: process.env.PATH, LINEAR_API_URL: `http://127.0.0.1:${api.address().port}/graphql`, ISSUECHAN_LINEAR_ENV_FILE: path.join(dir, 'linear.env') },
}, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr })))

test('linear.mjs comment: resolves the ref, adds the invisible marker once, passes --parent', async () => {
  calls.length = 0
  assert.equal((await cli('comment', 'https://linear.app/ws/issue/REN-106/t', '--body', 'hello', '--parent', 'p1')).code, 0)
  const input = calls.find(c => c.query.includes('commentCreate')).variables.input
  assert.deepEqual(input, { issueId: 'uuid-REN-106', body: 'hello\n\n[//]: # (issue-channel:bot)\n', parentId: 'p1' })
  calls.length = 0
  await cli('comment', 'linear:REN#106', '--body', 'x\n\n[//]: # (issue-channel:bot)', '--no-marker')
  assert.equal(calls.find(c => c.query.includes('commentCreate')).variables.input.body, 'x\n\n[//]: # (issue-channel:bot)\n')
})

test('linear.mjs set-state by type picks the team state; delete-comment reports gone and exits 1', async () => {
  calls.length = 0
  const s = await cli('set-state', 'REN-106', 'completed')
  assert.equal(s.stdout.trim(), 'state: Done')
  assert.equal(calls.find(c => c.query.includes('issueUpdate')).variables.i.stateId, 's1')
  const d = await cli('delete-comment', 'c9', 'gone')
  assert.equal(d.code, 1)
  assert.match(d.stdout, /c9: deleted\ngone: already gone/)
  // One argument with newline-separated ids (what an unquoted $ids gives in zsh) is split, not sent as one id.
  calls.length = 0
  assert.match((await cli('delete-comment', 'c1\nc2 c3')).stdout, /c1: deleted\nc2: deleted\nc3: deleted/)
  assert.deepEqual(calls.map(c => c.variables.id), ['c1', 'c2', 'c3'])
  assert.match((await cli('comment', 'not-a-ref', '--body', 'x')).stderr, /not a Linear issue ref/)
})

test('linear.mjs create: team by key, title/description, --state in-progress picks "In Progress" (not "In Review")', async () => {
  calls.length = 0
  const r = await cli('create', 'ren', '--title', 'pi-durable try', '--description', 'd', '--state', 'in-progress')
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { identifier: 'REN-9', url: 'https://linear.app/x/issue/REN-9', state: 'In Progress' })
  assert.deepEqual(calls.find(c => c.query.includes('issueCreate')).variables.i, { teamId: 'team-1', title: 'pi-durable try', description: 'd', stateId: 's3' })
  calls.length = 0
  await cli('set-state', 'REN-9', 'started')
  assert.equal(calls.find(c => c.query.includes('issueUpdate')).variables.i.stateId, 's3', 'type "started" = first by position')
  assert.match((await cli('create', 'NOPE', '--title', 'x')).stderr, /no team NOPE/)
  assert.match((await cli('create', 'REN')).stderr, /usage: create/)
})

test('linear.mjs edit-comment replaces the body and keeps the marker', async () => {
  calls.length = 0
  assert.equal((await cli('edit-comment', 'c5', '--body', 'new text')).stdout.trim(), 'updated u2')
  assert.deepEqual(calls[0].variables, { id: 'c5', i: { body: 'new text\n\n[//]: # (issue-channel:bot)\n' } })
})

test('linear.mjs help aliases and command help print usage without credentials or API calls', async () => {
  calls.length = 0
  for (const args of [[], ['--help'], ['-h'], ['help'], ['create', '--help'], ['comment', '-h']]) {
    const r = await new Promise(resolve => execFile(process.execPath,
      [fileURLToPath(new URL('./linear.mjs', import.meta.url)), ...args], {
        env: { PATH: process.env.PATH, LINEAR_API_URL: `http://127.0.0.1:${api.address().port}/graphql`,
          ISSUECHAN_LINEAR_ENV_FILE: path.join(dir, 'missing.env') },
      }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr })))
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stderr, '')
    assert.match(r.stdout, /Usage: linear\.mjs/)
    for (const command of ['whoami', 'issue', 'comment', 'edit-comment', 'delete-comment', 'set-description', 'set-state', 'create']) {
      assert.ok(r.stdout.includes(`  ${command}`), command)
    }
    assert.match(r.stdout, /ISSUECHAN_LINEAR_ENV_FILE/)
  }
  assert.deepEqual(calls, [])
})

test('linear.mjs unknown commands suggest help and help-like body text remains a value', async () => {
  calls.length = 0
  const r = await cli('unknown-command')
  assert.equal(r.code, 2)
  assert.match(r.stderr, /unknown command "unknown-command"; run linear\.mjs --help/)
  assert.deepEqual(calls, [])
  assert.equal((await cli('comment', 'REN-9', '--body', '--help')).code, 0)
  assert.equal(calls.find(c => c.query.includes('commentCreate')).variables.input.body,
    '--help\n\n[//]: # (issue-channel:bot)\n')
})
