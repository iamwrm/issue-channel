// fleet.sh end to end on a private tmux server: two fake agents (a script that starts a fake channel, the same
// process shape as Claude Code) are snapshotted, the tmux server is killed, and recover brings both back,
// verified against a fake issue-channel server. Nothing touches the user's tmux, agents or issue-channel server.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'

const FLEET = fileURLToPath(new URL('./fleet.sh', import.meta.url))
const hasTmux = spawnSync('tmux', ['-V']).status === 0
const pause = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, ms = 15000) {
  const end = Date.now() + ms
  while (!(await fn())) { if (Date.now() > end) assert.fail('timed out'); await pause(200) }
}
// spawnSync would block the event loop, and with it the fake server the script polls.
const run = (args, env) => new Promise(resolve => {
  const p = spawn('bash', [FLEET, ...args], { env })
  let stdout = '', stderr = ''
  p.stdout.on('data', d => { stdout += d }); p.stderr.on('data', d => { stderr += d })
  p.on('close', status => resolve({ status, stdout, stderr }))
})

test('fleet.sh: usage and missing snapshot', async () => {
  const r = await run(['--help'], process.env)
  assert.equal(r.status, 2)
  assert.match(r.stderr, /fleet.sh snapshot/)
  const dir = mkdtempSync(fileURLToPath(new URL('./.fleet-test-', import.meta.url)))
  try {
    assert.match((await run(['status'], { ...process.env, ISSUECHAN_STATE_DIR: dir })).stderr, /no snapshot at/)
    assert.match((await run(['bogus'], process.env)).stderr, /unknown command/)
  } finally { spawnSync('rm', ['-rf', dir]) }
})

test('fleet.sh: snapshot live agents only, recover them after the tmux server is gone', { skip: !hasTmux && 'tmux is not installed', timeout: 90000 }, async t => {
  const dir = mkdtempSync(fileURLToPath(new URL('./.fleet-test-', import.meta.url))) // not /tmp: may be noexec
  const sock = join(dir, 'tmux.sock'), state = join(dir, 'state'), claude = join(dir, 'claude-config')
  mkdirSync(state); mkdirSync(join(claude, 'projects', '-w'), { recursive: true })
  const tmux = (...a) => spawnSync('tmux', ['-S', sock, ...a], { encoding: 'utf8' })

  // Fake issue-channel server: the fake channels register, fleet.sh asks.
  const regs = []
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (req.method === 'PUT') {
      let raw = ''; req.on('data', d => { raw += d }); req.on('end', () => { regs.push({ ...JSON.parse(raw), at: Date.now() }); res.end('{}') })
      return
    }
    const within = Number(u.searchParams.get('active_within') ?? 900) * 1000
    const subscriptions = regs.filter(r => r.repo === u.searchParams.get('repo') && r.issue === Number(u.searchParams.get('issue')) && Date.now() - r.at <= within)
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ subscriptions }))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  t.after(() => { tmux('kill-server'); server.close(); spawnSync('rm', ['-rf', dir]) })

  // The fake channel registers every subscription in its state file, like the real one does on resume.
  const chan = join(dir, 'fleet-fake-channel.mjs')
  writeFileSync(chan, `import fs from 'node:fs'
const st = JSON.parse(fs.readFileSync(process.env.ISSUECHAN_STATE_DIR + '/cc-' + process.env.CLAUDE_CODE_SESSION_ID + '.json', 'utf8'))
for (const s of Object.values(st.subs)) await fetch(process.env.ISSUECHAN_URL + '/api/subscriptions', { method: 'PUT', body: JSON.stringify({ repo: s.repo, issue: s.issue, session: st.session }) })
setInterval(() => {}, 1000)
`)
  const fake = join(dir, 'fakeclaude')
  writeFileSync(fake, `#!/bin/bash
sid=''; while (($#)); do [[ $1 == --resume ]] && sid=$2; shift; done
CLAUDE_CODE_SESSION_ID=$sid ${JSON.stringify(process.execPath)} ${JSON.stringify(chan)} &
echo '  ⏵⏵ bypass permissions on'
wait
`, { mode: 0o755 })

  const agents = [['alpha', 'f1ee7a01-1111-4111-8111-111111111111', 7], ['beta', 'f1ee7a02-2222-4222-8222-222222222222', 8]]
  for (const [name, sid, issue] of agents) {
    writeFileSync(join(state, `cc-${sid}.json`), JSON.stringify({ session: name, subs: { [`o/r#${issue}`]: { repo: 'o/r', issue, flushed: 1, open: [] } } }))
    writeFileSync(join(claude, 'projects', '-w', `${sid}.jsonl`), '{"type":"user"}\n{"type":"assistant"}\n')
  }
  // A leftover state file whose agent is gone: must not be saved or revived.
  writeFileSync(join(state, 'cc-f1ee7a03-3333-4333-8333-333333333333.json'), JSON.stringify({ session: 'stale', subs: { 'o/r#9': { repo: 'o/r', issue: 9 } } }))

  const env = { ...process.env, TMUX: `${sock},0,0`, ISSUECHAN_STATE_DIR: state, CLAUDE_CONFIG_DIR: claude, ISSUECHAN_URL: url,
    ISSUECHAN_API_KEY: 'test', ISSUECHAN_FLEET_CHANNEL: chan, CLAUDE_CODE_SESSION_ID: '', TMUX_PANE: '' }
  const shell = 'bash --norc --noprofile -i'
  spawnSync('tmux', ['-S', sock, '-f', '/dev/null', 'new-session', '-d', '-s', 'fl', '-n', 'alpha', '-c', dir, '-x', '120', '-y', '30', shell], { env })
  tmux('new-window', '-d', '-t', 'fl:', '-n', 'beta', '-c', dir, shell)
  tmux('set-option', '-w', '-t', 'fl:beta', '@issuechan_agent', 'beta')
  for (const [name, sid] of agents) tmux('send-keys', '-t', `fl:${name}`, '-l', `${fake} --dangerously-skip-permissions --dangerously-load-development-channels server:issuechan --resume ${sid}`), tmux('send-keys', '-t', `fl:${name}`, 'Enter')
  await until(() => regs.length >= 2)

  const out = join(dir, 'snap.json')
  const s = await run(['snapshot', '--out', out], env)
  assert.equal(s.status, 0, s.stderr)
  const snap = JSON.parse(readFileSync(out, 'utf8'))
  assert.deepEqual(snap.agents.map(a => [a.name, a.session_id, a.tmux.window_name, a.tmux.tag, a.cwd]),
    [['alpha', agents[0][1], 'alpha', '', dir], ['beta', agents[1][1], 'beta', 'beta', dir]])
  assert.deepEqual(snap.agents[0].launch.argv, [fake], 'the wrapper script, as typed, without the flags fleet adds back')
  assert.deepEqual(snap.agents[1].subscriptions, [{ repo: 'o/r', issue: 8, mode: 'bot' }])
  assert.equal(snap.server, url, "the server URL comes from the channel's environment")

  // The "container restart": tmux and every agent gone.
  tmux('kill-server')
  await until(() => spawnSync('pgrep', ['-f', chan]).status !== 0)
  const st = JSON.parse((await run(['status', out], env)).stdout)
  assert.deepEqual(st.agents.map(a => a.running), [false, false])

  const dry = await run(['recover', out, '--dry-run'], env)
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stderr, /would open fl:0 "alpha" .*--resume f1ee7a01/)
  assert.notEqual(tmux('has-session').status, 0, 'a dry run opens nothing')

  const r = await run(['recover', out, '--timeout', '20'], env)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout).map(x => [x.name, x.status]), [['alpha', 'ok'], ['beta', 'ok']])
  assert.deepEqual(tmux('list-windows', '-t', 'fl', '-F', '#{window_name} #{@issuechan_agent}').stdout.trim().split('\n'), ['alpha ', 'beta beta'])
  assert.equal(regs.filter(x => x.session === 'stale').length, 0)

  const again = await run(['recover', out], env)
  assert.deepEqual(JSON.parse(again.stdout).map(x => x.status), ['running', 'running'], 'recover is idempotent')

  // An agent that never registers under its saved name fails: its window is closed and the exit status is 1.
  tmux('kill-server')
  await until(() => spawnSync('pgrep', ['-f', chan]).status !== 0)
  const ghost = join(dir, 'ghost.json')
  writeFileSync(ghost, JSON.stringify({ ...snap, agents: [{ ...snap.agents[0], name: 'ghost' }] }))
  const g = await run(['recover', ghost, '--timeout', '4'], env)
  assert.equal(g.status, 1)
  assert.match(JSON.parse(g.stdout)[0].error, /not registered on o\/r#7 within 4s, window closed/)
  assert.notEqual(tmux('has-session', '-t', 'fl').status, 0, 'its window (the only one) is gone')
})
