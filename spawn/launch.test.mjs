// spawn/launch.sh: reading an agent's start command from its process tree (fake agents: `sleep` with the session
// id in its environment stands in for a tool process, its parent for Claude Code, under an interactive shell).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const LAUNCH = fileURLToPath(new URL('./launch.sh', import.meta.url))
const detectOnce = sid => spawnSync('bash', ['-c', `. "${LAUNCH}"; launch_detect ${sid} || exit 3; launch_cmd --resume ${sid}`], { encoding: 'utf8' })
// The fake agent takes a moment to start under load: retry while its session isn't visible yet.
async function detect(sid, { until = r => r.status === 0 || /credential/.test(r.stderr) } = {}) {
  let r
  for (let i = 0; i < 25; i++) { r = detectOnce(sid); if (until(r)) break; await sleep(200) }
  return r
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Next to this file rather than in the temp dir, which may be mounted noexec.
function fixture(t) {
  const dir = mkdtempSync(fileURLToPath(new URL('./.launch-test-', import.meta.url)))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const script = (name, body) => { const p = join(dir, name); writeFileSync(p, `#!/bin/bash\n${body}\n`); chmodSync(p, 0o755); return p }
  script('fakeclaude', 'CLAUDE_CODE_SESSION_ID=$FAKE_SID sleep 30\n:')
  return { dir, script }
}

// Start <cmd> from an interactive shell, the way a user types it in a pane.
async function typed(cmd, t) {
  const sh = spawn('bash', ['--norc', '--noprofile', '-i'], { stdio: ['pipe', 'ignore', 'ignore'] })
  t.after(() => { spawnSync('pkill', ['-P', String(sh.pid)]); sh.kill('SIGKILL') })
  sh.stdin.write(`${cmd} &\n`)
}

test('launch.sh: a wrapper that runs claude as a child is repeated as typed, without --resume', async t => {
  const f = fixture(t)
  const w = f.script('clauded', '"$(dirname "$0")/fakeclaude" "$@"\n:')
  const sid = '11111111-1111-4111-8111-111111111111'
  await typed(`FAKE_SID=${sid} ${w} --model opus --resume old --dangerously-load-development-channels server:issuechan server:other`, t)
  const r = await detect(sid)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), `${w} --model opus --dangerously-skip-permissions --dangerously-load-development-channels server:issuechan server:other --resume ${sid}`)
})

test('launch.sh: an exec wrapper leaves claude itself, with the settings the wrapper added', async t => {
  const f = fixture(t)
  const w = f.script('clauded', 'export CLAUDE_CODE_FROM_WRAPPER=1\nexec "$(dirname "$0")/fakeclaude" "$@"')
  const sid = '22222222-2222-4222-8222-222222222222'
  await typed(`FAKE_SID=${sid} ${w} -c`, t)
  const r = await detect(sid)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), `env CLAUDE_CODE_FROM_WRAPPER=1 ${join(f.dir, 'fakeclaude')} --dangerously-skip-permissions --dangerously-load-development-channels server:issuechan --resume ${sid}`)
})

test('launch.sh: a credential in the start command is not repeated: detection gives up', async t => {
  const f = fixture(t)
  const sid = '33333333-3333-4333-8333-333333333333'
  await typed(`FAKE_SID=${sid} ANTHROPIC_API_KEY=not-a-real-key ${join(f.dir, 'fakeclaude')}`, t)
  const r = await detect(sid)
  assert.equal(r.status, 3)
  assert.match(r.stderr, /set ANTHROPIC_API_KEY; not repeating a credential/)
  assert.doesNotMatch(r.stderr + r.stdout, /not-a-real-key/)
})

test('launch.sh: no process of that session: not detected', () => {
  assert.equal(detectOnce('44444444-4444-4444-8444-444444444444').status, 3)
})
