// restart-agent.sh argument checks (the full flow needs herdr and a real agent; see spawn/README.md for the live test).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
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

test('restart-agent.sh: one restart per pane at a time', async () => {
  const state = mkdtempSync(join(tmpdir(), 'ra-state-'))
  const lock = join(state, 'restart-w9_p9.lock')
  // an independent process holds the pane's lock, like a restart already in progress
  const holder = spawn('flock', [lock, 'sleep', '10'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 300))
  try {
    const r = spawnSync('bash', [fileURLToPath(new URL('./restart-agent.sh', import.meta.url)), '--pane', 'w9:p9', '--session', '9ca18c5a-0038-46f6-a495-3b886558c14d'],
      { encoding: 'utf8', timeout: 20000, env: { ...process.env, ISSUECHAN_STATE_DIR: state, ISSUECHAN_LAUNCHER: 'true' } })
    assert.match(r.stderr, /another restart is already running for pane w9:p9/)
  } finally { holder.kill() }
})

test('restart-agent.sh: refuses a session that is not running, before touching any pane', () => {
  const state = mkdtempSync(join(tmpdir(), 'ra-state-'))
  const r = spawnSync('bash', [fileURLToPath(new URL('./restart-agent.sh', import.meta.url)), '--pane', 'w9:p9', '--session', '9ca18c5a-0038-46f6-a495-3b886558c14d'],
    { encoding: 'utf8', timeout: 20000, env: { ...process.env, ISSUECHAN_STATE_DIR: state } })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no running Claude Code process for session 9ca18c5a/)
})

// The 2026-10-22 incident: a test's restart, aimed at a fake session, picked up the caller's $TMUX_PANE and
// /exit-ed the real agent there. The session runs in one pane of a private tmux server; --pane names another.
const hasTmux = spawnSync('tmux', ['-V']).status === 0
test('restart-agent.sh: refuses a tmux pane the session does not run in, and types nothing there', { skip: !hasTmux && 'tmux is not installed' }, async t => {
  const dir = mkdtempSync(fileURLToPath(new URL('./.ra-test-', import.meta.url))) // not /tmp: may be noexec
  const sock = join(dir, 'tmux.sock'), sid = '66666666-6666-4666-8666-666666666666'
  const tmux = (...a) => spawnSync('tmux', ['-S', sock, ...a], { encoding: 'utf8' })
  t.after(() => { tmux('kill-server'); spawnSync('rm', ['-rf', dir]) })
  writeFileSync(join(dir, 'fakeclaude'), `#!/bin/bash\nCLAUDE_CODE_SESSION_ID=${sid} sleep 30\n:\n`, { mode: 0o755 })
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'ra', '-x', '120', '-y', '30', `${join(dir, 'fakeclaude')}`)
  const other = tmux('new-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'ra', 'bash --norc --noprofile -i').stdout.trim()
  await new Promise(r => setTimeout(r, 700))
  const env = { ...process.env, ISSUECHAN_STATE_DIR: dir, TMUX: `${sock},0,0`, TMUX_PANE: other }
  const r = spawnSync('bash', [fileURLToPath(new URL('./restart-agent.sh', import.meta.url)), '--pane', other, '--session', sid],
    { encoding: 'utf8', timeout: 20000, env })
  assert.equal(r.status, 1, r.stderr)
  assert.match(r.stderr, /does not run in tmux pane/)
  assert.doesNotMatch(tmux('capture-pane', '-p', '-t', other).stdout, /\/exit|--resume/)
})
