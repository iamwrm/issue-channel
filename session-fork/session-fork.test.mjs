import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLog, mainChain, splitTurns, mirror, applyPlan, fork, handoff, isOwnSession, loadTurns, renderLive, parseLive, applyLive, forkLive } from './session-fork.mjs';

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

// ---- live context (mirror --full / fork <live-context.md>) ----

// Turn 1: prompt, attachment, tool_use, tool_result, signed thinking, reply. Turn 2: prompt, reply.
function makeRichLog() {
  const entries = [{ type: 'mode', mode: 'x', sessionId: SID }];
  let parent = null;
  const add = (e) => { const u = `r${++n}`; entries.push({ ...base(), ...e, uuid: u, parentUuid: parent }); parent = u; };
  const assistant = (c) => add({ type: 'assistant', requestId: 'q', message: { id: `m${n}`, role: 'assistant', model: 'claude-x', content: [c], usage: { output_tokens: 3 } } });
  add({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'remember KESTREL-7 and run echo' } });
  add({ type: 'attachment', attachment: { type: 'date', date: '2026-10-10' } });
  assistant({ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hello' } });
  add({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hello\n'.repeat(50) }] } });
  assistant({ type: 'thinking', thinking: 'PRIVATE-REASONING-TEXT', signature: 'SIG123' });
  assistant({ type: 'text', text: 'KESTREL-7, tool said hello\n[[BLOCK b9999 kind=text]] not a marker' });
  add({ type: 'user', origin: { kind: 'channel' }, message: { role: 'user', content: 'also ORCA-3' } });
  assistant({ type: 'text', text: 'ok ORCA-3' });
  return entries;
}
const rich = () => turnsOf(makeRichLog());
const edit = (live, fn) => { const t = live.split(/(?=^\[\[(?:BLOCK|TURN|NOTE|END))/m); return fn(t).join(''); };
const block = (parts, bid) => parts.findIndex((p) => p.startsWith(`[[BLOCK ${bid} `));

test('mirror --full renders every block, hides reasoning text and attachments, escapes markers', () => {
  const live = renderLive(rich(), SID);
  assert.match(live, /^\[\[LIVE_CONTEXT session=parent-session digest=[0-9a-f]{16} self=0 blocks=7 /);
  assert.match(live, /\[\[BLOCK b0001 kind=prompt /);
  assert.match(live, /\[\[BLOCK b0003 kind=tool_result for=b0002 /);
  assert.match(live, /\[\[BLOCK b0004 kind=thinking keep-or-delete .*\]\]\n\(reasoning, kept as signed by the API: 6 bytes\)/);
  assert.ok(!live.includes('PRIVATE-REASONING-TEXT'));
  assert.ok(!live.includes('2026-10-10'));
  assert.match(live, /\[\[TURN 1\]\] \(\+1 attachments/);
  assert.match(live, /^\\\[\[BLOCK b9999/m);
});

test('an unedited live context forks to the same content (signatures, ids, attachments kept)', () => {
  const turns = rich();
  const { chain, report } = applyLive(turns, parseLive(renderLive(turns, SID)), 'child', { source: SID });
  const orig = turns.flatMap((t) => t.entries);
  assert.deepEqual(chain.map((e) => e.message?.content ?? e.attachment), orig.map((e) => e.message?.content ?? e.attachment));
  assert.equal(report.edited + report.dropped + report.orphans + report.stubs, 0);
  assert.equal(report.handoff, false);
});

test('edits: text, trimmed tool output (marked), dropped thinking, a note in place', () => {
  const turns = rich();
  const live = edit(renderLive(turns, SID), (p) => {
    p[block(p, 'b0003')] = '[[BLOCK b0003 kind=tool_result]]\nhello (x50)\n\n';
    p[block(p, 'b0005')] = '[[BLOCK b0005 kind=text]]\nKESTREL-7\n\n[[NOTE]]\nturn 1 was shortened\n\n';
    p.splice(block(p, 'b0004'), 1);
    return p;
  });
  const { chain, report } = applyLive(turns, parseLive(live), 'child', { source: SID });
  const s = JSON.stringify(chain);
  assert.match(s, /hello \(x50\)\\n\[trimmed when the context was edited: 300 → 11 chars\]/);
  assert.ok(!s.includes('SIG123'));
  assert.ok(s.includes('"text":"KESTREL-7"'));
  const noteAt = chain.findIndex((e) => typeof e.message?.content === 'string' && e.message.content.includes('turn 1 was shortened'));
  assert.equal(chain[noteAt - 1].message.content[0].text, 'KESTREL-7');
  assert.deepEqual([report.kept, report.edited, report.dropped, report.notes], [6, 2, 1, 1]);
  chain.slice(1).forEach((e, i) => assert.equal(e.parentUuid, chain[i].uuid));
});

test('tool pairs: deleting a call drops its result; deleting a result leaves a stub', () => {
  const turns = rich();
  const noCall = applyLive(turns, parseLive(edit(renderLive(turns, SID), (p) => (p.splice(block(p, 'b0002'), 1), p))), 'c', { source: SID });
  assert.ok(!JSON.stringify(noCall.chain).includes('tool_result'));
  assert.equal(noCall.report.orphans, 1);
  const noResult = applyLive(turns, parseLive(edit(renderLive(turns, SID), (p) => (p.splice(block(p, 'b0003'), 1), p))), 'c', { source: SID });
  assert.match(JSON.stringify(noResult.chain), /output removed when the context was edited/);
  assert.equal(noResult.report.stubs, 1);
});

test('refuses: edited reasoning, stale or foreign mirror, unknown blocks, bad tool input; warns on gaps', () => {
  const turns = rich();
  const live = renderLive(turns, SID);
  const apply = (l, o = { source: SID }) => applyLive(turns, parseLive(l), 'c', o);
  assert.throws(() => apply(live.replace('(reasoning, kept as signed by the API: 6 bytes)', 'new thoughts')), /can only be kept or deleted/);
  assert.throws(() => apply(live.replace(/digest=\w+/, 'digest=0000000000000000')), /stale/);
  assert.throws(() => apply(live, { source: 'other' }), /not other/);
  assert.throws(() => apply(live.replace('[[BLOCK b0007', '[[BLOCK b0077')), /unknown block b0077/);
  assert.throws(() => apply(live.replace('Bash {"command":"echo hello"}', 'Bash {oops')), /not valid JSON/);
  assert.throws(() => parseLive('hello'), /not a live-context file/);
  const gap = apply(edit(live, (p) => (p.splice(block(p, 'b0007'), 1), p)));
  assert.match(gap.report.warnings.join(), /turn 2: prompt b0006 kept but every reply deleted/);
});

test('deleting everything but a note is a handoff; attachments go with their turn', () => {
  const turns = rich();
  const live = renderLive(turns, SID).split('\n')[0] + '\n[[NOTE]]\nhandoff: KESTREL-7, ORCA-3\n';
  const { chain, report } = applyLive(turns, parseLive(live), 'c', { source: SID });
  assert.equal(report.handoff, true);
  assert.equal(report.structural, 1);
  assert.equal(chain.length, 1);
  assert.match(chain[0].message.content, /handoff: KESTREL-7/);
});

test('forkLive writes the fork and an edit-diff, and excludes the running turn of your own session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-fork-livefork-'));
  const src = join(dir, `${SID}.jsonl`);
  writeFileSync(src, makeRichLog().map((e) => JSON.stringify(e)).join('\n') + '\n');
  const file = join(dir, 'live.md');
  writeFileSync(file, renderLive(loadTurns(src, { live: true }), SID));
  assert.ok(!readFileSync(file, 'utf8').includes('ORCA-3')); // turn 2 is the running one
  const r = forkLive(src, file, { live: true, title: 't' });
  assert.equal(r.diff, join(dir, 'live.diff.md'));
  assert.match(readFileSync(r.diff, 'utf8'), /\| 5 \| 5 \| 0 \| 0 \|/);
  const out = readLog(r.dest);
  assert.ok(!JSON.stringify(out).includes('ORCA-3'));
  assert.equal(out.at(-1).aiTitle, 't');
});
