// restart-agent.sh argument checks (the full flow needs herdr and a real agent; see spawn/README.md for the live test).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const run = (...args) => spawnSync('bash', [fileURLToPath(new URL('./restart-agent.sh', import.meta.url)), ...args], { encoding: 'utf8' })

test('restart-agent.sh: usage, required args, uuid check, missing plan', () => {
  const h = run('--help')
  assert.equal(h.status, 2)
  assert.match(h.stderr, /--fork <plan.json> \[--keep-last\]/)
  assert.match(run('--pane', 'w1:p1').stderr, /--pane and --session <uuid> are required/)
  assert.match(run('--pane', 'w1:p1', '--session', 'not-a-uuid').stderr, /are required/)
  assert.match(run('--pane', 'w1:p1', '--session', '9ca18c5a-0038-46f6-a495-3b886558c14d', '--fork', '/nonexistent/plan.json').stderr, /no such plan file/)
  assert.match(run('--bogus').stderr, /unknown argument/)
})
