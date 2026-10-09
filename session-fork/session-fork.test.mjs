import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLog, mainChain, splitTurns, mirror, applyPlan, fork, handoff, isOwnSession, loadTurns } from './session-fork.mjs';

const SID = 'parent-session';
let n = 0;
const base = () => ({ sessionId: SID, cwd: '/w', gitBranch: 'main', version: '1', entrypoint: 'cli', userType: 'external', isSidechain: false, timestamp: '2026-10-09T00:00:00Z' });

// A linear log: preamble, two complete turns (one with a tool call), and an incomplete turn.
function makeLog() {
  const entries = [{ type: 'mode', mode: 'x', sessionId: SID }, { type: 'permission-mode', permissionMode: 'x', sessionId: SID }];
  let parent = null;
  const add = (e) => { const u = `u${++n}`; entries.push({ ...base(), ...e, uuid: u, parentUuid: parent }); parent = u; };
  const assistant = (content) => add({ type: 'assistant', session_id: SID, requestId: `req${n}`, message: { id: `m${n}`, type: 'message', role: 'assistant', model: 'claude-x', content, usage: { input_tokens: 5, output_tokens: 7, cache_creation: { ephemeral_5m_input_tokens: 9 }, service_tier: 'standard' } } });
  add({ type: 'system', subtype: 'informational', content: 'start' });
  add({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'first prompt: remember 43' } });
  assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]);
  add({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
  assistant([{ type: 'text', text: 'first reply' }]);
  add({ type: 'user', origin: { kind: 'channel' }, message: { role: 'user', content: 'second prompt: secret OCELOT' } });
  assistant([{ type: 'text', text: 'second reply' }]);
  add({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'third prompt' } });
  assistant([{ type: 'tool_use', id: 't9', name: 'Bash', input: {} }]);
  entries.push({ type: 'last-prompt', lastPrompt: 'third prompt', leafUuid: parent });
  return entries;
}

const turnsOf = (entries) => splitTurns(mainChain(entries));

test('splits the main chain into a preamble and turns, and flags the incomplete one', () => {
  const turns = turnsOf(makeLog());
  assert.equal(turns.length, 4);
  assert.equal(turns[1].entries.length, 4); // prompt, tool_use, tool_result, reply
  const m = mirror(turns);
  assert.match(m, /\[\[TURN 1 from=human tokens~\d+\]\]/);
  assert.match(m, /tools: Bash×1/);
  assert.match(m, /assistant: second reply/);
  assert.match(m, /\[\[TURN 3 from=human tokens~\d+ incomplete\]\]/);
});

test('replace inserts a note, drops the incomplete turn, rewrites ids and re-links the chain', () => {
  const out = applyPlan(turnsOf(makeLog()), { ops: [{ op: 'replace', from: 2, to: 2, note: 'summary: OCELOT was mentioned' }], note: 'handoff' }, 'child');
  const texts = out.filter((e) => e.type === 'user').map((e) => (typeof e.message.content === 'string' ? e.message.content : 'tool_result'));
  assert.deepEqual(texts.map((t) => t.split('\n').at(-1)), ['first prompt: remember 43', 'tool_result', 'summary: OCELOT was mentioned', 'handoff']);
  assert.ok(!JSON.stringify(out).includes('second prompt'));
  assert.ok(!JSON.stringify(out).includes('third prompt'));
  assert.ok(out.every((e) => e.sessionId === 'child'));
  assert.ok(out.filter((e) => e.session_id).every((e) => e.session_id === 'child'));
  assert.equal(out[0].parentUuid, null);
  out.slice(1).forEach((e, i) => assert.equal(e.parentUuid, out[i].uuid));
  // Each note is followed by an assistant ack, so roles keep alternating.
  const roles = out.filter((e) => e.type !== 'system').map((e) => e.type);
  assert.deepEqual(roles.slice(-4), ['user', 'assistant', 'user', 'assistant']);
});

test('copied replies carry no requestId and zero usage, so they are not billed twice', () => {
  const src = makeLog();
  const out = applyPlan(turnsOf(src), { ops: [] }, 'child');
  const copied = out.filter((e) => e.type === 'assistant');
  assert.equal(copied.length, 3); // turn 1: tool_use + reply, turn 2: reply
  for (const e of copied) {
    assert.equal(e.requestId, undefined);
    assert.deepEqual(e.message.usage, { input_tokens: 0, output_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0 }, service_tier: 'standard' });
    assert.match(e.message.id, /^m\d+$/); // ids are kept
  }
  // The source entries are not mutated.
  assert.ok(src.filter((e) => e.type === 'assistant').every((e) => e.requestId && e.message.usage.output_tokens === 7));
});

test('drop removes turns without a note', () => {
  const out = applyPlan(turnsOf(makeLog()), { ops: [{ op: 'drop', from: 1, to: 1 }] }, 'child');
  assert.ok(!JSON.stringify(out).includes('remember 43'));
  assert.ok(JSON.stringify(out).includes('second prompt'));
  assert.ok(!out.some((e) => Array.isArray(e.message?.content) && e.message.content.some((c) => c.type === 'tool_use')));
});

test('rejects bad plans', () => {
  const turns = turnsOf(makeLog());
  assert.throws(() => applyPlan(turns, { ops: [{ op: 'drop', from: 0, to: 0 }] }, 'c'), /bad range/);
  assert.throws(() => applyPlan(turns, { ops: [{ op: 'drop', from: 1, to: 9 }] }, 'c'), /bad range/);
  assert.throws(() => applyPlan(turns, { ops: [{ op: 'drop', from: 1, to: 2 }, { op: 'drop', from: 2, to: 2 }] }, 'c'), /edited twice/);
  assert.throws(() => applyPlan(turns, { ops: [{ op: 'squash', from: 1, to: 1 }] }, 'c'), /unknown op/);
});

test('fork writes a new resumable log next to the source and leaves the source untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-fork-'));
  const src = join(dir, `${SID}.jsonl`);
  const raw = makeLog().map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(src, raw);
  const r = fork(src, { ops: [], title: 'child title' });
  assert.equal(readFileSync(src, 'utf8'), raw);
  assert.equal(r.dest, join(dir, `${r.id}.jsonl`));
  const out = readLog(r.dest);
  assert.ok(out.every((e) => e.sessionId === r.id));
  assert.deepEqual(out.slice(0, 2).map((e) => e.type), ['mode', 'permission-mode']);
  assert.ok(!out.some((e) => e.type === 'last-prompt'));
  assert.equal(out.at(-1).aiTitle, 'child title');
  // The resumable chain is complete: every parent exists, ending at the last kept reply.
  const ids = new Set(out.map((e) => e.uuid));
  assert.ok(out.filter((e) => e.parentUuid).every((e) => ids.has(e.parentUuid)));
  assert.equal(mainChain(out).length, r.entries);
});

// Forking your own live session: the running turn's earlier tool calls already have results,
// and the call running the fork isn't logged yet, so the turn looks complete.
function makeLiveLog() {
  const entries = makeLog();
  const leaf = entries.findLast((e) => e.uuid).uuid;
  entries.push({ ...base(), type: 'user', uuid: `u${++n}`, parentUuid: leaf, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', content: 'mirror output' }] } });
  return entries;
}

test('the last turn of your own session counts as running and is always dropped', () => {
  assert.ok(isOwnSession(`/p/${SID}.jsonl`, SID));
  assert.ok(!isOwnSession('/p/other.jsonl', SID));
  assert.ok(!isOwnSession(`/p/${SID}.jsonl`, undefined));

  const dir = mkdtempSync(join(tmpdir(), 'session-fork-live-'));
  const src = join(dir, `${SID}.jsonl`);
  writeFileSync(src, makeLiveLog().map((e) => JSON.stringify(e)).join('\n') + '\n');

  // Someone else's session: the answered last turn is complete and kept.
  assert.match(mirror(loadTurns(src, { live: false })), /\[\[TURN 3 from=human tokens~\d+\]\]/);
  assert.ok(JSON.stringify(readLog(fork(src, { ops: [] }, { live: false }).dest)).includes('third prompt'));

  // Your own session, detected from CLAUDE_CODE_SESSION_ID: the last turn is running and dropped.
  const saved = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = SID;
  try {
    assert.match(mirror(loadTurns(src)), /\[\[TURN 3 from=human tokens~\d+ running\]\]/);
    const out = JSON.stringify(readLog(fork(src, { ops: [], note: 'handoff' }).dest));
    assert.ok(!out.includes('third prompt'));
    assert.ok(out.includes('second reply') && out.includes('handoff'));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = saved;
  }
});

test('handoff copies issuechan state to the child session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-fork-state-'));
  writeFileSync(join(dir, 'cc-a.json'), '{"subs":[1]}');
  assert.equal(handoff('a', 'b', dir), join(dir, 'cc-b.json'));
  assert.equal(readFileSync(join(dir, 'cc-b.json'), 'utf8'), '{"subs":[1]}');
  assert.throws(() => handoff('missing', 'b', dir), /no issuechan state/);
  assert.ok(existsSync(join(dir, 'cc-a.json')));
});
