// The skill's helper scripts: ref parsing, and linear.mjs against a fake Linear API.
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

let api, calls, dir
before(async () => {
  calls = []
  api = http.createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const { query, variables } = JSON.parse(raw)
    calls.push({ query, variables })
    const data = query.includes('issue(id:') && !query.includes('team') ? { issue: { id: `uuid-${variables.id}` } }
      : query.includes('team { states') ? { issue: { id: 'uuid', team: { states: { nodes: [
        { id: 's1', name: 'Done', type: 'completed', position: 3 }, { id: 's2', name: 'Todo', type: 'unstarted', position: 1 }] } } } }
      : query.includes('commentCreate') ? { commentCreate: { success: true, comment: { id: 'c1', url: 'u' } } }
      : query.includes('issueUpdate') ? { issueUpdate: { success: true, issue: { state: { name: 'Done' } } } }
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

const cli = (...args) => new Promise(resolve => execFile(process.execPath, [new URL('./linear.mjs', import.meta.url).pathname, ...args], {
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
  assert.match((await cli('comment', 'not-a-ref', '--body', 'x')).stderr, /not a Linear issue ref/)
})
