// Actual-terminal suite: node --test adapters/pi/tui.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fixture, hasPi, piCommand, waitFor, jsonLines, messageText, deliveryHeader } from './fixture-runtime.mjs'

const hasTmux = spawnSync('tmux', ['-V'], { timeout: 3000 }).status === 0
const quote = s => `'${String(s).replaceAll("'", "'\\''")}'`

test('actual Pi TUI renders compact markers, multiple count, native message, and hides marker with none', {
  skip: !hasPi ? 'Install Pi 1.1.0 or set ISSUECHAN_TEST_PI' : !hasTmux ? 'tmux is not installed' : false,
  timeout: 35000,
}, async t => {
  const f = await fixture(t, { faultProxy: true })
  const socket = path.join(f.root, 'tmux.sock')
  const session = `issuechan-${crypto.randomBytes(4).toString('hex')}`
  const tmux = (...args) => {
    const result = spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 0, `tmux ${args.join(' ')}: ${result.stderr}`)
    return result.stdout
  }
  f.onCleanup(() => { spawnSync('tmux', ['-S', socket, 'kill-server'], { timeout: 5000 }) })
  const ready = path.join(f.root, 'tui-ready.json')
  const launch = ['env', ...Object.entries(f.env).map(([key, value]) => `${key}=${value}`), piCommand, ...f.commonArgs,
    '--issue-channel-issue', 'o/r#3', '--issue-channel-name', 'terminal', '--issue-channel-ready-file', ready]
  tmux('new-session', '-d', '-s', session, '-x', '120', '-y', '36', '-c', path.join(f.root, 'work'),
    `exec ${launch.map(quote).join(' ')}`)
  // Native footer assertions use the displayed pane, not captured stdout or a mock UI.
  const pane = () => tmux('capture-pane', '-p', '-t', session)
  const send = text => { tmux('send-keys', '-t', session, '-l', text); tmux('send-keys', '-t', session, 'Enter') }
  await waitFor(() => fs.existsSync(ready) && JSON.parse(fs.readFileSync(ready, 'utf8')).ready === true, `TUI readiness; pane: ${pane()}`)
  await waitFor(() => /● issue #3/.test(pane()), `GitHub status; pane: ${pane()}`)
  send('/issue-channel status')
  await waitFor(() => /o\/r#3 \[bot\] listening/.test(pane()), 'Actual TUI status identifies bot mode')
  send('TEST_TOOL ' + JSON.stringify({ name: 'issue_subscribe', arguments: { repo: 'linear:ENG', issue: 4 } }))
  await waitFor(() => /● (?:issues 2|issue.*(?:\+1|\(2\)|2 issues))/.test(pane()), `multiple count; pane: ${pane()}`)
  send('TEST_TOOL ' + JSON.stringify({ name: 'issue_unsubscribe', arguments: { repo: 'o/r', issue: 3 } }))
  await waitFor(() => /● issue ENG-4/.test(pane()), `Linear compact marker; pane: ${pane()}`)
  f.faults.queries = true
  // End the in-flight real long poll; its next request receives the local injected outage.
  await f.server.linearComment(4, 'ordinary reconnect probe')
  await waitFor(() => /○ issue ENG-4.*reconnecting/.test(pane()), `real reconnect status; pane: ${pane()}`)
  f.faults.queries = false
  await f.server.linearComment(4, 'ordinary reconnect recovery probe')
  await waitFor(() => /● issue ENG-4/.test(pane()), `listener recovers after outage; pane: ${pane()}`)
  const statusLines = []
  for (const theme of ['light', 'dark']) {
    send(`/test-theme ${theme}`)
    await waitFor(() => fs.existsSync(path.join(f.env.ISSUECHAN_TEST_CONTROL, 'theme-applied'))
      && fs.readFileSync(path.join(f.env.ISSUECHAN_TEST_CONTROL, 'theme-applied'), 'utf8') === theme, `${theme} native theme applied`)
    await waitFor(() => /● issue ENG-4/.test(pane()), `marker remains visible in ${theme} theme`)
    statusLines.push(tmux('capture-pane', '-e', '-p', '-t', session).split('\n').find(line => line.includes('● issue ENG-4')))
    tmux('resize-window', '-t', session, '-x', '40', '-y', '36')
    assert.equal(tmux('display-message', '-p', '-t', session, '#{pane_width}').trim(), '40')
    await waitFor(() => /● issue ENG-4/.test(pane()), `compact marker survives 40-column ${theme} terminal`)
    tmux('resize-window', '-t', session, '-x', '120', '-y', '36')
    await waitFor(() => /● issue ENG-4/.test(pane()), `marker survives expanding ${theme} terminal`)
  }
  assert.notEqual(statusLines[0], statusLines[1], 'The actual ANSI status line follows light/dark theme rather than cached colors')
  send('TEST_TOOL ' + JSON.stringify({ name: 'issue_subscribe', arguments: { repo: 'linear:ENG', issue: 4, mode: 'updates' } }))
  await waitFor(() => JSON.parse(fs.readFileSync(ready, 'utf8')).subscriptions.some(s => s.repo === 'linear:ENG' && s.mode === 'updates'),
    'Real native tool changes subscription mode to updates')
  send('/issue-channel status')
  await waitFor(() => /linear:ENG#4 \[updates\] listening/.test(pane()), 'Actual TUI status identifies updates mode')
  await waitFor(() => /● issue ENG-4/.test(pane()), 'Compact healthy marker remains visible in updates mode')
  await f.server.linearComment(4, 'ordinary terminal-native-proof')
  await waitFor(() => pane().includes('terminal-native-proof'), `native message in real terminal; pane: ${pane()}`)
  await waitFor(() => f.snapshots().some(s => s.messages.some(m => m.role === 'user'
    && messageText(m).includes('terminal-native-proof') && deliveryHeader.test(messageText(m)))), 'TUI native user message reaches provider')
  const files = fs.readdirSync(path.join(f.root, 'sessions')).filter(name => name.endsWith('.jsonl'))
  assert.ok(files.some(file => jsonLines(path.join(f.root, 'sessions', file)).some(e => e.type === 'message'
    && e.message?.role === 'user' && messageText(e.message).includes('terminal-native-proof'))), 'TUI native user message persisted by Pi')
  send('TEST_TOOL ' + JSON.stringify({ name: 'issue_unsubscribe', arguments: { repo: 'linear:ENG', issue: 4 } }))
  await waitFor(() => !pane().includes('● issue'), `no subscriptions hides footer status; pane: ${pane()}`)
  send('/issue-channel status')
  await waitFor(() => /no (?:active )?subscriptions|not subscribed|none/i.test(pane()), 'status command works in actual terminal')
  send('/test-shutdown')
  await waitFor(() => {
    const result = spawnSync('tmux', ['-S', socket, 'has-session', '-t', session], { timeout: 2000 })
    return result.status !== 0
  }, 'TUI shuts down and releases poll resources')
})
