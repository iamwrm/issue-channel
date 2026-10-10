// restart-agent.sh argument checks (the full flow needs herdr and a real agent; see spawn/README.md for the live test).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = (...args) => spawnSync('bash', [fileURLToPath(new URL('./restart-agent.sh', import.meta.url)), ...args], { encoding: 'utf8' })

test('restart-agent.sh: usage, required args, uuid check, --fork needs an edited live-context file', () => {
  const h = run('--help')
  assert.equal(h.status, 2)
  assert.match(h.stderr, /--fork <live-context.md> \[--keep-last\]/)
  assert.match(run('--pane', 'w1:p1').stderr, /--pane and --session <uuid> are required/)
  assert.match(run('--pane', 'w1:p1', '--session', 'not-a-uuid').stderr, /are required/)
  const sid = '9ca18c5a-0038-46f6-a495-3b886558c14d'
  assert.match(run('--pane', 'w1:p1', '--session', sid, '--fork', '/nonexistent/live.md').stderr, /no such file/)
  const plan = join(mkdtempSync(join(tmpdir(), 'restart-agent-')), 'plan.json')
  writeFileSync(plan, '{"ops":[]}')
  assert.match(run('--pane', 'w1:p1', '--session', sid, '--fork', plan).stderr, /needs an edited live-context file/)
  assert.match(run('--bogus').stderr, /unknown argument/)
})
