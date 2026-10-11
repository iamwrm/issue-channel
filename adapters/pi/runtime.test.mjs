// Real installed/pinned Pi CLI + native tools + signed webhooks; no model service.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { REPO, sleep } from '../testkit.mjs'
import { fixture, hasPi, waitFor, messageText, deliveryHeader, persistedDelivery, jsonLines } from './fixture-runtime.mjs'

const options = { skip: !hasPi && 'Install Pi 1.1.0 or set ISSUECHAN_TEST_PI', timeout: 30000 }
const flags = (f, issue = 'o/r#1', name = 'native') => ['--issue-channel-issue', issue, '--issue-channel-name', name,
  '--issue-channel-ready-file', path.join(f.root, 'ready.json')]
const deliveries = messages => messages.filter(m => m.role === 'user' && deliveryHeader.test(messageText(m)))

async function gatedRuntime(t, needle, gate = 'preflight') {
  const f = await fixture(t)
  f.env[gate === 'preflight' ? 'ISSUECHAN_TEST_PREFLIGHT_GATE' : 'ISSUECHAN_TEST_INPUT_GATE'] = '1'
  const rpc = await f.rpc(flags(f))
  await rpc.ready(path.join(f.root, 'ready.json'))
  await rpc.prompt('TEST_PERSIST_SEED') // Ensure restart targets a real existing session file.
  const state = await rpc.send('get_state')
  const inboxFile = path.join(f.server.stateDir, `pi-${state.sessionId}.inbox.json`)
  const traceFile = path.join(f.env.ISSUECHAN_TEST_CONTROL, `${gate}.jsonl`)
  await f.server.comment(1, `/bot native\n${needle}`)
  await waitFor(() => jsonLines(traceFile).some(e => e.phase === 'start'), 'native async admission blocked before disk append')
  await waitFor(() => fs.existsSync(inboxFile) && Object.keys(JSON.parse(fs.readFileSync(inboxFile, 'utf8')).pending).length === 1,
    'blocked admission remains durable')
  return { f, rpc, state, inboxFile, traceFile }
}

function releasePreflight(f, gate = 'preflight') {
  fs.writeFileSync(path.join(f.env.ISSUECHAN_TEST_CONTROL, `${gate}-release`), 'release')
}

// A provider-only sanity test also identifies Pi API incompatibilities independently of production.
test('deterministic test provider runs through actual Pi and persists actual model input', options, async t => {
  const f = await fixture(t)
  const rpc = await f.rpc()
  await rpc.prompt('TEST_HELLO')
  assert.equal((await rpc.send('get_state')).model.provider, 'issuechan-test')
  assert.ok(f.snapshots().some(s => s.messages.some(m => m.role === 'user' && messageText(m) === 'TEST_HELLO')))
  assert.ok((await rpc.messages()).some(m => m.role === 'assistant' && messageText(m) === 'TEST_OK'))
  const names = f.snapshots()[0].tools.map(tool => tool.name)
  for (const name of ['issue_subscribe', 'issue_unsubscribe', 'issue_subscriptions', 'issue_reply', 'issue_done']) assert.ok(names.includes(name), `Native tool ${name}`)
  assert.ok((await rpc.send('get_commands')).commands.some(c => c.name === 'issue-channel'))
  await rpc.send('prompt', { message: '/issue-channel status' })
})

test('startup flags, idle native user delivery, targeting, done/reply/unsubscribe', options, async t => {
  const f = await fixture(t)
  const rpc = await f.rpc(flags(f))
  const ready = await rpc.ready(path.join(f.root, 'ready.json'))
  assert.equal(ready.sessionId, (await rpc.send('get_state')).sessionId)
  assert.equal(ready.name, 'native')
  assert.equal(ready.subscriptions.length, 1)
  assert.deepEqual(await f.server.registered(1), ['native'])
  // A target is the sole first-line token, and only a registered name is targeted.
  const registration = { repo: REPO, issue: 1, session: 'other' }
  const register = async method => {
    const response = await fetch(`${f.server.base}/api/subscriptions`, { method,
      headers: { authorization: `Bearer ${f.env.ISSUECHAN_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(registration) })
    assert.equal(response.status, 200)
  }
  await register('PUT')
  await f.server.comment(1, '/bot other\nwrong-target')
  const id = await f.server.comment(1, '/bot native\nidle-native-proof')
  const entry = await persistedDelivery(rpc, 'idle-native-proof')
  const content = messageText(entry.message)
  assert.match(content, deliveryHeader)
  assert.match(content, /o\/r/)
  assert.match(content, /me/)
  assert.ok(content.includes(String(id)), 'Trigger comment provenance reaches the model')
  await waitFor(() => f.snapshots().some(s => s.messages.some(m => m.role === 'user' && messageText(m).includes('idle-native-proof'))), 'idle delivery reaches real provider')
  assert.equal(deliveries(await rpc.messages()).length, 1)
  await register('DELETE')
  await rpc.tool('issue_subscriptions')
  await rpc.tool('issue_done', { repo: REPO, issue: 1, comment_ids: [id] })
  await rpc.tool('issue_reply', { repo: REPO, issue: 1, summary: 'offline summary', body: 'offline full reply', done: false })
  const posted = jsonLines(f.env.ISSUECHAN_TEST_GH_LOG)
  assert.equal(posted.length, 1)
  assert.match(posted[0].body, /offline summary/)
  assert.match(posted[0].body, /offline full reply/)
  assert.match(posted[0].body, /pi/)
  await rpc.tool('issue_unsubscribe', { repo: REPO, issue: 1 })
  assert.deepEqual(await f.server.registered(1), [])
  await f.server.comment(1, '/bot native must-not-deliver')
  await sleep(250)
  assert.equal(deliveries(await rpc.messages()).length, 1)
})

test('burst of three idle deliveries admits only one delayed native preflight and persists all exactly once', options, async t => {
  const f = await fixture(t)
  f.env.ISSUECHAN_TEST_PREFLIGHT_GATE = '1'
  const rpc = await f.rpc(flags(f))
  await rpc.ready(path.join(f.root, 'ready.json'))
  const state = await rpc.send('get_state')
  const inboxFile = path.join(f.server.stateDir, `pi-${state.sessionId}.inbox.json`)
  const traceFile = path.join(f.env.ISSUECHAN_TEST_CONTROL, 'preflight.jsonl')
  await f.server.comment(1, '/bot native\nburst-proof-1')
  await waitFor(() => jsonLines(traceFile).some(e => e.phase === 'start'), 'first native prompt blocked in actual before_agent_start')
  await f.server.comment(1, '/bot native\nburst-proof-2')
  await f.server.comment(1, '/bot native\nburst-proof-3')
  await waitFor(() => fs.existsSync(inboxFile) && Object.keys(JSON.parse(fs.readFileSync(inboxFile, 'utf8')).pending).length === 3,
    'all three authenticated webhooks accepted durably during idle preflight')
  // Give any already-scheduled competing sendUserMessage calls a task boundary to enter the gate.
  await sleep(100)
  assert.equal(jsonLines(traceFile).filter(e => e.phase === 'start').length, 1, 'No competing idle prompts while first preflight is unresolved')
  assert.equal(f.snapshots().length, 0, 'Real provider has not started while before_agent_start is blocked')
  assert.equal(deliveries(jsonLines(state.sessionFile).filter(e => e.type === 'message').map(e => e.message)).length, 0,
    'None of the three can be acknowledged before actual Pi persistence')
  fs.writeFileSync(path.join(f.env.ISSUECHAN_TEST_CONTROL, 'preflight-release'), 'release')
  for (const n of [1, 2, 3]) await persistedDelivery(rpc, `burst-proof-${n}`)
  await waitFor(() => Object.keys(JSON.parse(fs.readFileSync(inboxFile, 'utf8')).pending).length === 0, 'all burst receipts acknowledged')
  await waitFor(async () => {
    const current = await rpc.send('get_state')
    return !current.isStreaming && current.pendingMessageCount === 0
  }, 'burst native runs settle')
  const persisted = deliveries(jsonLines(state.sessionFile).filter(e => e.type === 'message').map(e => e.message))
  assert.equal(persisted.length, 3)
  assert.equal(new Set(persisted.map(m => messageText(m).match(deliveryHeader)[1])).size, 3, 'Three unique stable delivery IDs')
  for (const n of [1, 2, 3]) {
    assert.equal(persisted.filter(m => messageText(m).includes(`burst-proof-${n}`)).length, 1)
    assert.ok(f.snapshots().some(s => s.messages.some(m => m.role === 'user' && messageText(m).includes(`burst-proof-${n}`))),
      `Real model input includes burst ${n}`)
  }
  assert.ok(jsonLines(traceFile).every(e => e.active <= 1), 'Native preflights never overlap')
  assert.ok(!rpc.events.some(e => e.type === 'extension_error' || (e.type === 'message_end' && e.message?.role === 'assistant'
    && ['error', 'aborted'].includes(e.message.stopReason))), `No competing-run or model errors: ${rpc.diagnostics()}`)
})

test('crash after core unsubscribe drops old inbox request before the same startup flag re-subscribes', options, async t => {
  const { f, rpc, state, inboxFile, traceFile } = await gatedRuntime(t, 'cancelled-before-crash-proof')
  const oldId = Object.keys(JSON.parse(fs.readFileSync(inboxFile, 'utf8')).pending)[0]
  // Kill a real Pi with its admission unresolved, then seed the precise durable crash boundary:
  // core unsubscribe committed, but inbox discard did not. No fabricated delivery/session messages.
  await new Promise(resolve => { rpc.child.once('exit', resolve); rpc.child.kill('SIGKILL') })
  await rpc.close()
  const coreFile = path.join(f.server.stateDir, `pi-${state.sessionId}.json`)
  const coreState = JSON.parse(fs.readFileSync(coreFile, 'utf8'))
  assert.equal(Object.keys(coreState.subs).length, 1)
  fs.writeFileSync(coreFile, JSON.stringify({ ...coreState, subs: {} }) + '\n')
  fs.rmSync(path.join(f.root, 'ready.json'), { force: true })
  const restarted = await f.rpc([...flags(f), '--session', state.sessionFile])
  const ready = await restarted.ready(path.join(f.root, 'ready.json'))
  assert.equal(ready.sessionId, state.sessionId)
  assert.equal(ready.subscriptions.length, 1, 'Explicit startup ref legitimately re-subscribes after pruning')
  const inbox = JSON.parse(fs.readFileSync(inboxFile, 'utf8'))
  assert.equal(Object.keys(inbox.pending).length, 0, 'Cancelled old input is pruned BEFORE startup re-subscription')
  assert.ok(!inbox.received.includes(oldId), 'Discarding cancelled input does not fabricate a disk receipt')
  await sleep(100)
  assert.equal(jsonLines(traceFile).filter(e => e.phase === 'start').length, 1, 'Restart never re-admits cancelled request')
  releasePreflight(f)
  await f.server.comment(1, '/bot native\nfresh-after-cancel-proof')
  await persistedDelivery(restarted, 'fresh-after-cancel-proof')
  assert.equal(deliveries(await restarted.messages()).length, 1)
  assert.ok(!jsonLines(state.sessionFile).some(e => e.message?.role === 'user' && messageText(e.message).includes('cancelled-before-crash-proof')))
  assert.ok(!f.snapshots().some(s => s.messages.some(m => m.role === 'user' && messageText(m).includes('cancelled-before-crash-proof'))))
})

test('retry refuses unresolved native async admission rather than starting a duplicate preflight', options, async t => {
  const { f, rpc, state, inboxFile, traceFile } = await gatedRuntime(t, 'retry-admission-proof')
  const before = rpc.events.length
  const response = await rpc.send('prompt', { message: '/issue-channel retry' })
  assert.equal(response.disposition, 'handled')
  const warning = rpc.events.slice(before).find(e => e.type === 'extension_ui_request' && e.method === 'notify'
    && /admission.*unresolved|wait.*native queued/i.test(e.message))
  assert.ok(warning, 'Actual RPC UI reports refusal while native admission is unresolved')
  assert.equal(warning.notifyType, 'warning')
  await sleep(100)
  assert.equal(jsonLines(traceFile).filter(e => e.phase === 'start').length, 1, 'Retry must not issue a second idle sendUserMessage')
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(inboxFile, 'utf8')).pending).length, 1)
  assert.equal(deliveries(jsonLines(state.sessionFile).filter(e => e.type === 'message').map(e => e.message)).length, 0)
  releasePreflight(f)
  await persistedDelivery(rpc, 'retry-admission-proof')
  await waitFor(() => Object.keys(JSON.parse(fs.readFileSync(inboxFile, 'utf8')).pending).length === 0, 'original admission acknowledged')
  assert.equal(deliveries(await rpc.messages()).length, 1, 'Original native input persists once after retry refusal')
})

test('reload preserves unresolved process admission and waits for its receipt instead of sending again', options, async t => {
  const { f, rpc, state, inboxFile, traceFile } = await gatedRuntime(t, 'reload-old-admission-proof')
  const oldId = Object.keys(JSON.parse(fs.readFileSync(inboxFile, 'utf8')).pending)[0]
  await rpc.send('prompt', { message: '/test-reload' })
  assert.equal((await rpc.send('get_state')).sessionId, state.sessionId)
  await f.server.comment(1, '/bot native\nreload-new-admission-proof')
  await waitFor(() => Object.keys(JSON.parse(fs.readFileSync(inboxFile, 'utf8')).pending).length === 2,
    'Restored runtime durably accepts new delivery while old admission is unresolved')
  await sleep(100)
  assert.equal(jsonLines(traceFile).filter(e => e.phase === 'start').length, 1,
    'Restored runtime must neither resend old input nor concurrently admit new input')
  assert.equal(deliveries(jsonLines(state.sessionFile).filter(e => e.type === 'message').map(e => e.message)).length, 0)
  releasePreflight(f)
  await persistedDelivery(rpc, 'reload-old-admission-proof')
  await persistedDelivery(rpc, 'reload-new-admission-proof')
  await waitFor(() => Object.keys(JSON.parse(fs.readFileSync(inboxFile, 'utf8')).pending).length === 0, 'post-reload disk receipts drain inbox')
  const persisted = deliveries(jsonLines(state.sessionFile).filter(e => e.type === 'message').map(e => e.message))
  assert.equal(persisted.length, 2)
  assert.equal(persisted.filter(m => messageText(m).includes(oldId)).length, 1)
  for (const needle of ['reload-old-admission-proof', 'reload-new-admission-proof']) {
    assert.equal(persisted.filter(m => messageText(m).includes(needle)).length, 1)
    await waitFor(() => f.snapshots().some(s => s.messages.some(m => m.role === 'user' && messageText(m).includes(needle))), `actual model observes ${needle}`)
  }
})

test('busy delivery is native steer at the pending tool boundary, not followUp', options, async t => {
  const f = await fixture(t)
  const rpc = await f.rpc(flags(f))
  await rpc.ready(path.join(f.root, 'ready.json'))
  await rpc.send('prompt', { message: 'TEST_BUSY' })
  await waitFor(() => fs.existsSync(path.join(f.env.ISSUECHAN_TEST_CONTROL, 'gate-started')), 'real pending tool execution')
  await f.server.comment(1, '/bot native busy-steer-proof')
  await waitFor(async () => (await rpc.send('get_state')).pendingMessageCount > 0, 'delivery queued while tool is pending')
  assert.equal(f.snapshots().length, 1, 'No second model call while gate is blocked')
  const state = await rpc.send('get_state')
  const inboxFile = path.join(f.server.stateDir, `pi-${state.sessionId}.inbox.json`)
  const pending = JSON.parse(fs.readFileSync(inboxFile, 'utf8')).pending
  assert.equal(Object.keys(pending).length, 1, 'Enqueue alone cannot acknowledge durable input')
  assert.ok(!jsonLines(state.sessionFile).some(e => e.message?.role === 'user' && messageText(e.message).includes('busy-steer-proof')))
  fs.writeFileSync(path.join(f.env.ISSUECHAN_TEST_CONTROL, 'gate-release'), 'release')
  await persistedDelivery(rpc, 'busy-steer-proof')
  await waitFor(() => Object.keys(JSON.parse(fs.readFileSync(inboxFile, 'utf8')).pending).length === 0, 'ack only after disk persistence')
  await waitFor(() => rpc.events.some(e => e.type === 'agent_settled'), 'steered run settles')
  const snapshots = f.snapshots()
  assert.ok(snapshots.length >= 2)
  assert.ok(snapshots[1].messages.some(m => m.role === 'toolResult' && m.toolName === 'test_gate'))
  assert.ok(snapshots[1].messages.some(m => m.role === 'user' && messageText(m).includes('busy-steer-proof')),
    'The FIRST model request after the pending tool sees the issue message (followUp would fail this)')
  assert.ok(!(await rpc.messages()).some(m => m.role === 'assistant' && messageText(m).includes('BASELINE_COMPLETED_WITHOUT_STEER')))
})

test('Escape preserves uncertain input without auto/manual readmission; full persisted-session restart recovers once', options, async t => {
  const f = await fixture(t)
  const rpc = await f.rpc(flags(f))
  await rpc.ready(path.join(f.root, 'ready.json'))
  await rpc.send('prompt', { message: 'TEST_BUSY' })
  await waitFor(() => fs.existsSync(path.join(f.env.ISSUECHAN_TEST_CONTROL, 'gate-started')), 'pending tool before abort')
  await f.server.comment(1, '/bot native abort-recovery-proof')
  await waitFor(async () => (await rpc.send('get_state')).pendingMessageCount > 0, 'steering queued before Escape')
  const state = await rpc.send('get_state')
  const inboxFile = path.join(f.server.stateDir, `pi-${state.sessionId}.inbox.json`)
  const cleared = await rpc.send('clear_queue')
  assert.equal(cleared.steering.length, 1)
  assert.equal(cleared.followUp.length, 0, 'Native delivery must not use followUp')
  await rpc.send('abort')
  const count = f.snapshots().length
  await sleep(200)
  assert.equal(f.snapshots().length, count, 'Abort must not start another model turn')
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(inboxFile, 'utf8')).pending).length, 1)
  assert.ok(!jsonLines(state.sessionFile).some(e => e.message?.role === 'user' && messageText(e.message).includes('abort-recovery-proof')))
  await rpc.prompt('TEST_MANUAL_AFTER_ESCAPE')
  await sleep(100)
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(inboxFile, 'utf8')).pending).length, 1,
    'A manual turn cannot safely readmit an uncertain cleared native call')
  assert.equal(deliveries(await rpc.messages()).length, 0, 'Manual turn neither fabricates consumption nor duplicates input')
  const beforeRetry = rpc.events.length
  await rpc.send('prompt', { message: '/issue-channel retry' })
  assert.ok(rpc.events.slice(beforeRetry).some(e => e.type === 'extension_ui_request' && e.method === 'notify'
    && e.notifyType === 'warning' && /admission.*unresolved/i.test(e.message)), 'Retry refuses uncertain admission until full restart')
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(inboxFile, 'utf8')).pending).length, 1)
  await rpc.close()
  fs.rmSync(path.join(f.root, 'ready.json'), { force: true })
  const restarted = await f.rpc(['--session', state.sessionFile, '--issue-channel-ready-file', path.join(f.root, 'ready.json')])
  await restarted.ready(path.join(f.root, 'ready.json'))
  await persistedDelivery(restarted, 'abort-recovery-proof')
  await waitFor(() => Object.keys(JSON.parse(fs.readFileSync(inboxFile, 'utf8')).pending).length === 0, 'full-restart recovery acknowledged after actual disk receipt')
  assert.equal(deliveries(await restarted.messages()).length, 1, 'Full process restart recovers exactly one native input')
})

test('gated input survives unrelated manual run abort and refuses retry without duplicate admission', options, async t => {
  const { f, rpc, state, inboxFile, traceFile } = await gatedRuntime(t, 'input-abort-retry-proof', 'input-preflight')
  const before = await rpc.send('get_state')
  assert.equal(before.isStreaming, false)
  assert.equal(before.pendingMessageCount, 0, 'Admission is suspended in async input before Pi knows a run or queue exists')
  await rpc.send('prompt', { message: 'TEST_BUSY' })
  await waitFor(() => fs.existsSync(path.join(f.env.ISSUECHAN_TEST_CONTROL, 'gate-started')), 'unrelated manual tool run')
  await rpc.send('abort')
  const count = f.snapshots().length
  await sleep(100)
  assert.equal(f.snapshots().length, count, 'Unrelated abort does not auto-start issue input')
  await rpc.prompt('TEST_MANUAL_AFTER_INPUT_ABORT')
  const beforeRetry = rpc.events.length
  await rpc.send('prompt', { message: '/issue-channel retry' })
  assert.ok(rpc.events.slice(beforeRetry).some(e => e.type === 'extension_ui_request' && e.method === 'notify'
    && e.notifyType === 'warning' && /admission.*unresolved/i.test(e.message)), 'Abort must not erase the unresolved admission guard')
  await sleep(100)
  assert.equal(jsonLines(traceFile).filter(e => e.phase === 'start').length, 1,
    'Manual agent_start, settled abort and retry never create a competing input preflight')
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(inboxFile, 'utf8')).pending).length, 1)
  assert.equal(deliveries(jsonLines(state.sessionFile).filter(e => e.type === 'message').map(e => e.message)).length, 0)
  releasePreflight(f, 'input-preflight')
  await persistedDelivery(rpc, 'input-abort-retry-proof')
  await waitFor(() => Object.keys(JSON.parse(fs.readFileSync(inboxFile, 'utf8')).pending).length === 0, 'original gated input receives its real disk receipt')
  assert.equal(deliveries(await rpc.messages()).length, 1, 'Original preflight completes exactly once, without retry duplication')
  await rpc.close()
  delete f.env.ISSUECHAN_TEST_INPUT_GATE
  fs.rmSync(path.join(f.root, 'ready.json'), { force: true })
  const restarted = await f.rpc(['--session', state.sessionFile, '--issue-channel-ready-file', path.join(f.root, 'ready.json')])
  await restarted.ready(path.join(f.root, 'ready.json'))
  await sleep(100)
  assert.equal(deliveries(await restarted.messages()).length, 1, 'Full restart reconciles the existing receipt without replay')
})

test('Linear updates mode delivers ordinary signed comments as persisted native messages', options, async t => {
  const f = await fixture(t)
  const rpc = await f.rpc([...flags(f, 'linear:ENG#2'), '--issue-channel-mode', 'updates'])
  await rpc.ready(path.join(f.root, 'ready.json'))
  const id = await f.server.linearComment(2, 'ordinary-linear-update-proof')
  const entry = await persistedDelivery(rpc, 'ordinary-linear-update-proof')
  assert.match(messageText(entry.message), /ENG[-#]2/)
  assert.ok(messageText(entry.message).includes(id), 'Linear UUID provenance')
  await waitFor(() => f.snapshots().some(s => s.messages.some(m => m.role === 'user' && messageText(m).includes('ordinary-linear-update-proof'))), 'Linear delivery reaches provider')
})

test('startup issue/name flags never bleed into new or fork; switch/reload restores destination state', options, async t => {
  const f = await fixture(t)
  const rpc = await f.rpc(flags(f))
  await rpc.ready(path.join(f.root, 'ready.json'))
  await rpc.prompt('TEST_FORK_POINT')
  const original = await rpc.send('get_state')
  // Change the name through the real native tool, so it differs from the original flag.
  await rpc.tool('issue_subscribe', { repo: REPO, issue: 1, session: 'saved-name' })
  await rpc.send('prompt', { message: '/test-reload' })
  const restored = await rpc.tool('issue_subscriptions')
  assert.equal(restored.details.session, 'saved-name', 'Reload restores state rather than reapplying --issue-channel-name')
  assert.equal(restored.details.subscriptions.length, 1)
  await rpc.send('new_session')
  const fresh = await rpc.tool('issue_subscriptions')
  assert.equal(fresh.details.subscriptions.length, 0, 'New session does not inherit --issue-channel-issue')
  assert.notEqual(fresh.details.session, 'native', 'New session does not inherit --issue-channel-name')
  assert.notEqual(fresh.details.session, 'saved-name', 'New session does not inherit another session name')
  assert.deepEqual(await f.server.registered(1), [])
  await rpc.send('switch_session', { sessionPath: original.sessionFile })
  const destination = await rpc.tool('issue_subscriptions')
  assert.equal(destination.details.session, 'saved-name', 'Switch restores destination saved name')
  assert.equal(destination.details.subscriptions.length, 1, 'Switch restores destination subscriptions')
  const forkable = (await rpc.send('get_fork_messages')).messages.find(m => m.text === 'TEST_FORK_POINT')
  assert.ok(forkable, 'Fork uses a real persisted Pi user entry')
  const result = await rpc.send('fork', { entryId: forkable.entryId })
  assert.equal(result.cancelled, false)
  assert.notEqual((await rpc.send('get_state')).sessionId, original.sessionId)
  const forked = await rpc.tool('issue_subscriptions')
  assert.equal(forked.details.subscriptions.length, 0, 'Fork does not inherit startup refs or parent subscriptions')
  assert.notEqual(forked.details.session, 'native', 'Fork does not inherit original startup name')
  assert.notEqual(forked.details.session, 'saved-name', 'Fork has independent listener identity')
  assert.deepEqual(await f.server.registered(1), [])
  await rpc.prompt('TEST_NO_HIDDEN_INSTRUCTIONS')
  assert.equal((await rpc.messages()).filter(m => m.role === 'custom').length, 0, 'No repeated hidden custom instruction messages')
})

test('reload and restart/resume recover subscriptions without replaying persisted delivery; new session is empty', options, async t => {
  const f = await fixture(t)
  let rpc = await f.rpc(flags(f))
  await rpc.ready(path.join(f.root, 'ready.json'))
  await f.server.comment(1, '/bot native before-reload-proof')
  const first = await persistedDelivery(rpc, 'before-reload-proof')
  const header = messageText(first.message).match(deliveryHeader)[0]
  await waitFor(() => rpc.events.some(e => e.type === 'agent_settled'), 'idle before reload')
  const state = await rpc.send('get_state')
  await rpc.send('prompt', { message: '/test-reload' })
  await waitFor(async () => (await f.server.registered(1)).includes('native'), 'registration after reload')
  await f.server.comment(1, '/bot native after-reload-proof')
  await persistedDelivery(rpc, 'after-reload-proof')
  await rpc.close()
  // No issue/name flags: restoration must come from durable state, not re-subscription.
  rpc = await f.rpc(['--session', state.sessionFile])
  await rpc.send('get_state')
  await f.server.comment(1, '/bot native after-resume-proof')
  await persistedDelivery(rpc, 'after-resume-proof')
  assert.equal((await rpc.messages()).filter(m => m.role === 'user' && messageText(m).includes(header)).length, 1,
    'Persisted delivery ID survives reload/resume exactly once')
  await waitFor(async () => !(await rpc.send('get_state')).isStreaming, 'resume run idle')
  await rpc.send('new_session')
  assert.notEqual((await rpc.send('get_state')).sessionId, state.sessionId)
  const subscriptions = await rpc.tool('issue_subscriptions')
  assert.match(messageText(subscriptions), /none|no (?:active )?subscriptions|\[\]|not subscribed/i)
  await f.server.comment(1, '/bot native old-session-must-not-leak')
  await sleep(250)
  assert.equal(deliveries(await rpc.messages()).length, 0)
})
