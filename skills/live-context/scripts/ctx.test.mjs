// ctx.mjs open / list / apply checks (the switch itself needs herdr; see session-fork/README.md for the live test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CTX = fileURLToPath(new URL('./ctx.mjs', import.meta.url));
const SID = '11111111-2222-3333-4444-555555555555';

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'ctx-home-'));
  const dir = join(home, '.claude', 'projects', '-w');
  mkdirSync(dir, { recursive: true });
  const base = { sessionId: SID, cwd: '/w', version: '1', isSidechain: false, timestamp: '2026-10-10T00:00:00Z' };
  const e = [
    { ...base, type: 'user', uuid: 'a', parentUuid: null, message: { role: 'user', content: 'triage the 502s' } },
    { ...base, type: 'assistant', uuid: 'b', parentUuid: 'a', message: { id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE', signature: 'S' }] } },
    { ...base, type: 'assistant', uuid: 'c', parentUuid: 'b', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'deploy 4f1c2e9 cut the pool to 10' }] } },
    { ...base, type: 'user', uuid: 'd', parentUuid: 'c', message: { role: 'user', content: 'compact yourself' } },
  ];
  writeFileSync(join(dir, `${SID}.jsonl`), e.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const tmp = mkdtempSync(join(tmpdir(), 'ctx-tmp-'));
  const env = { ...process.env, HOME: home, TMPDIR: tmp, CLAUDE_CODE_SESSION_ID: SID, HERDR_PANE_ID: '' };
  return (...args) => spawnSync('node', [CTX, ...args], { encoding: 'utf8', env });
}

test('open writes the context without the current turn and without reasoning text; list shows headers only', () => {
  const ctx = setup();
  const o = ctx('open');
  assert.equal(o.status, 0, o.stderr);
  const file = o.stdout.match(/Context file: (\S+)/)[1];
  const text = readFileSync(file, 'utf8');
  assert.match(text, /deploy 4f1c2e9/);
  assert.ok(!text.includes('compact yourself')); // the running turn
  assert.ok(!text.includes('PRIVATE'));
  const l = ctx('list');
  assert.deepEqual(l.stdout.trim().split('\n').map((x) => x.split(' ').slice(0, 2).join(' ')), ['[[TURN 1]]', '[[BLOCK b0001', '[[BLOCK b0002', '[[BLOCK b0003', '[[TURN 2]]']);
});

test('apply checks the edit before anything else, and needs a herdr pane for the switch', () => {
  const ctx = setup();
  const file = ctx('open').stdout.match(/Context file: (\S+)/)[1];
  writeFileSync(file, readFileSync(file, 'utf8').replace('(reasoning block: keep or delete)', 'edited'));
  assert.match(ctx('apply').stderr, /can only be kept or deleted/);
  writeFileSync(file, readFileSync(file, 'utf8').replace('edited', '(reasoning block: keep or delete)').replace(/digest=\w+/, 'digest=0000000000000000'));
  assert.match(ctx('apply').stderr, /moved on since `ctx open`/);
  ctx('open');
  assert.match(ctx('apply').stderr, /needs a herdr pane/);
});

test('apply without open, and unknown commands', () => {
  const ctx = setup();
  assert.match(ctx('apply').stderr, /run `ctx open` first/);
  assert.equal(ctx('bogus').status, 2);
});
