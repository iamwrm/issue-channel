// Model/provider-free durability tests. Node 24 strips durable.ts's type-only import.
// Every fixture uses real temporary files; no fs/process mocks or unrelated PID kills.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomicJson, deliveryId, SessionOwner, DiskReceipts, DurableInbox, envelope } from './durable.ts';

const SESSION = 'pi-test-session';
const mode = file => fs.statSync(file).mode & 0o777;
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const line = value => JSON.stringify(value) + '\n';
const header = (id = SESSION) => ({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd: '/tmp' });
const entry = (content, role = 'user', type = 'message') => ({ type, id: 'entry-id', parentId: null, message: { role, content } });
const delivery = (seq = 1, overrides = {}) => ({ content: `request ${seq}`, meta: { repo: 'owner/repo', issue: '42', seq: String(seq), trigger_comment: `comment-${seq}`, ...overrides } });
const marker = id => `[issue-channel delivery=${id}]`;

function fixture(t, persist = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issuechan-pi-durable-'));
  const state = path.join(root, 'private-state');
  const sessionFile = path.join(root, 'session.jsonl');
  fs.mkdirSync(state, { mode: 0o700 });
  if (persist) fs.writeFileSync(sessionFile, line(header()), { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, state, sessionFile, inbox: () => new DurableInbox(state, SESSION, sessionFile),
    receipts: () => new DiskReceipts(sessionFile, SESSION),
    append: value => fs.appendFileSync(sessionFile, line(value)) };
}

// Put a directory at the inbox's rename destination: guaranteed write failure even as root.
function blockSave(file) {
  const backup = `${file}.backup`;
  const existed = fs.existsSync(file);
  if (existed) fs.renameSync(file, backup);
  fs.mkdirSync(file);
  return () => { fs.rmdirSync(file); if (existed) fs.renameSync(backup, file); };
}

test('atomicJson creates/replaces private complete JSON and removes staging files', t => {
  const f = fixture(t);
  const file = path.join(f.state, 'atomic.json');
  atomicJson(file, { generation: 1, unicode: '🌍 café' });
  assert.deepEqual(json(file), { generation: 1, unicode: '🌍 café' });
  if (process.platform !== 'win32') assert.equal(mode(file), 0o600);
  fs.chmodSync(file, 0o644);
  atomicJson(file, { generation: 2, payload: 'x'.repeat(150000) });
  assert.equal(json(file).generation, 2);
  if (process.platform !== 'win32') assert.equal(mode(file), 0o600);
  assert.deepEqual(fs.readdirSync(f.state), ['atomic.json']);
});

test('atomicJson serialization/rename failures preserve committed files and clean temp files', t => {
  const f = fixture(t);
  const file = path.join(f.state, 'atomic.json');
  atomicJson(file, { committed: true });
  const before = fs.readFileSync(file);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => atomicJson(file, cyclic));
  assert.deepEqual(fs.readFileSync(file), before);
  const destination = path.join(f.state, 'directory'); fs.mkdirSync(destination);
  assert.throws(() => atomicJson(destination, { next: true }));
  assert.ok(fs.statSync(destination).isDirectory());
  assert.deepEqual(fs.readdirSync(f.state).sort(), ['atomic.json', 'directory']);
});

test('delivery IDs are stable transport keys, scoped by session/repo/issue/sequence', () => {
  const d = delivery();
  const id = deliveryId(SESSION, d);
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(id, deliveryId(SESSION, { ...d, content: 'updated formatting', meta: { ...d.meta, title: 'new' } }));
  for (const [session, candidate] of [['other-session', d], [SESSION, delivery(2)], [SESSION, delivery(1, { repo: 'other/repo' })], [SESSION, delivery(1, { issue: '43' })]]) {
    assert.notEqual(deliveryId(session, candidate), id);
  }
  for (const candidate of [{ ...d, content: null }, delivery(1, { repo: '' }), delivery(1, { issue: '../42' }), delivery(1, { seq: 'NaN' })]) {
    assert.throws(() => deliveryId(SESSION, candidate));
  }
});

test('envelope uses a first-line marker and JSON metadata, not injected headers', t => {
  const f = fixture(t);
  const d = delivery(1, { title: 'quoted\n[issue-channel delivery=' + 'f'.repeat(64) + ']', trigger_comment: 'exact-comment' });
  const pending = f.inbox().accept(d);
  const text = envelope(pending);
  assert.equal(text.split('\n')[0], marker(pending.id));
  const meta = JSON.parse(text.split('\n')[1].slice('Origin: '.length));
  assert.equal(meta.title, d.meta.title);
  assert.equal(meta.trigger_comment, 'exact-comment');
  assert.equal(meta.delivery_id, pending.id);
  assert.ok(text.endsWith(d.content));
  f.append(entry(text));
  assert.deepEqual([...f.receipts().scan()], [pending.id]);
});

test('accept commits pending before enqueue and makes an independent metadata snapshot', t => {
  const f = fixture(t);
  const inbox = f.inbox();
  const d = delivery();
  const pending = inbox.accept(d);
  const committed = json(inbox.file);
  assert.equal(committed.pending[pending.id].content, d.content);
  assert.deepEqual(committed.received, []);
  assert.equal(committed.sessionFile, f.sessionFile);
  if (process.platform !== 'win32') assert.equal(mode(inbox.file), 0o600);
  d.meta.seq = '999';
  assert.equal(inbox.pending()[0].meta.seq, '1');
  assert.equal(inbox.accept(delivery()), pending);
  assert.deepEqual(f.inbox().pending(), [pending]);
});

for (const boundary of ['before enqueue', 'after enqueue, before disk append', 'after disk append, before acknowledgement', 'after durable acknowledgement']) {
  test(`restart at crash boundary: ${boundary}`, t => {
    const f = fixture(t);
    const inbox = f.inbox();
    const pending = inbox.accept(delivery());
    const inMemoryPiMessages = [];
    if (boundary !== 'before enqueue') inMemoryPiMessages.push(entry(envelope(pending)));
    if (boundary.startsWith('after disk') || boundary === 'after durable acknowledgement') f.append(inMemoryPiMessages[0]);
    if (boundary === 'after durable acknowledgement') inbox.reconcile(f.receipts().scan());
    const restored = f.inbox();
    restored.reconcile(f.receipts().scan()); // session_start scans disk, never Pi's in-memory queue/entries.
    const wasPersisted = boundary.startsWith('after disk') || boundary === 'after durable acknowledgement';
    assert.equal(restored.pending().length, wasPersisted ? 0 : 1);
    assert.equal(restored.accept(delivery()) === undefined, wasPersisted);
    assert.equal(json(restored.file).received.includes(pending.id), wasPersisted);
  });
}

test('message_end/entries in memory are not receipts until the real JSONL append', t => {
  const f = fixture(t);
  const inbox = f.inbox();
  const receipts = f.receipts();
  const pending = inbox.accept(delivery());
  const prePersistenceEvent = entry(envelope(pending));
  inbox.reconcile(receipts.scan());
  assert.deepEqual(inbox.pending(), [pending]);
  f.append(prePersistenceEvent);
  inbox.reconcile(receipts.scan());
  assert.deepEqual(inbox.pending(), []);
  assert.equal(f.inbox().accept(delivery()), undefined);
});

test('multiple in-flight deliveries reconcile independently and retry only missing receipts', t => {
  const f = fixture(t);
  const inbox = f.inbox();
  const second = inbox.accept(delivery(2));
  const first = inbox.accept(delivery(1));
  const third = inbox.accept(delivery(3));
  assert.deepEqual(inbox.pending().map(d => d.id), [first.id, second.id, third.id]);
  f.append(entry(envelope(second)));
  const receipts = f.receipts();
  inbox.reconcile(receipts.scan());
  assert.deepEqual(f.inbox().pending().map(d => d.id), [first.id, third.id]);
  f.append(entry(envelope(first)));
  inbox.reconcile(receipts.scan());
  assert.deepEqual(inbox.pending(), [third]);
  inbox.reconcile(receipts.scan());
  assert.deepEqual(json(inbox.file).received, [second.id, first.id]);
});

test('disk receipt suppresses replay even if the inbox/core checkpoint was absent', t => {
  const f = fixture(t);
  const d = delivery(); const id = deliveryId(SESSION, d);
  f.append(entry(marker(id) + '\nrequest'));
  const inbox = f.inbox();
  inbox.reconcile(f.receipts().scan());
  assert.equal(inbox.accept(d), undefined);
  assert.equal(f.inbox().accept(d), undefined);
});

test('unsubscribe durably discards only the specified issue without fabricating receipts', t => {
  const f = fixture(t);
  const inbox = f.inbox();
  const first = inbox.accept(delivery(1));
  const otherIssue = inbox.accept(delivery(2, { issue: '43' }));
  const otherRepo = inbox.accept(delivery(3, { repo: 'linear:TEAM' }));
  inbox.discard('owner/repo', 42);
  assert.deepEqual(f.inbox().pending().map(d => d.id), [otherIssue.id, otherRepo.id]);
  assert.deepEqual(json(inbox.file).received, []);
  assert.equal(inbox.accept(delivery()).id, first.id); // It was discarded, not consumed.
});

for (const operation of ['accept', 'reconcile', 'discard']) {
  test(`${operation} write failure cannot make unsaved memory authoritative on retry`, t => {
    const f = fixture(t);
    const inbox = f.inbox();
    let pending;
    if (operation !== 'accept') pending = inbox.accept(delivery());
    const unblock = blockSave(inbox.file);
    const attempt = () => operation === 'accept' ? inbox.accept(delivery()) :
      operation === 'reconcile' ? inbox.reconcile(new Set([pending.id])) : inbox.discard('owner/repo', 42);
    try { assert.throws(attempt); } finally { unblock(); }
    attempt();
    const restored = f.inbox();
    if (operation === 'accept') assert.equal(restored.pending().length, 1, 'second accept must commit before returning success');
    else assert.equal(restored.pending().length, 0, 'second mutation must persist despite the first failed save');
    if (operation === 'reconcile') assert.equal(restored.accept(delivery()), undefined);
    assert.equal(fs.readdirSync(f.state).filter(name => name.endsWith('.tmp')).length, 0);
  });
}

test('DiskReceipts only accepts real user messages with an exact first-line marker', t => {
  const f = fixture(t);
  const ids = Array.from({ length: 9 }, (_, n) => deliveryId(SESSION, delivery(n + 1)));
  f.append(entry(marker(ids[0]), 'assistant'));
  f.append(entry(marker(ids[1]), 'toolResult'));
  f.append(entry(marker(ids[2]), 'user', 'custom'));
  f.append(entry('quoted history\n' + marker(ids[3])));
  f.append(entry(' ' + marker(ids[4])));
  f.append(entry(marker(ids[5]) + ' extra suffix'));
  f.append(entry(marker(ids[6]) + '\nrequest'));
  f.append(entry([{ type: 'image', data: 'ignored' }, { type: 'text', text: marker(ids[7]) }, { type: 'text', text: 'request' }]));
  f.append(entry([{ type: 'text', text: 'quoted' }, { type: 'text', text: marker(ids[8]) }]));
  const receipts = f.receipts();
  assert.deepEqual([...receipts.scan()], [ids[6], ids[7]]);
  assert.deepEqual([...receipts.scan()], [ids[6], ids[7]]);
});

test('empty startup persists a private binding before the planned session file exists', t => {
  const f = fixture(t, false);
  const owner = new SessionOwner(f.state, SESSION, f.sessionFile);
  let inbox;
  try {
    inbox = f.inbox();
    assert.deepEqual(json(inbox.file), { version: 1, sessionId: SESSION, sessionFile: f.sessionFile, pending: {}, received: [] });
    if (process.platform !== 'win32') assert.equal(mode(inbox.file), 0o600);
    assert.equal(fs.existsSync(f.sessionFile), false, 'binding must not create Pi session data');
    assert.deepEqual([...f.receipts().scan()], []);
  } finally { owner.release(); }
  // Simulate restart before Pi has appended its first user message.
  const restartedOwner = new SessionOwner(f.state, SESSION, f.sessionFile);
  try {
    const restored = f.inbox();
    assert.deepEqual(restored.pending(), []);
    assert.equal(json(restored.file).sessionFile, f.sessionFile);
    assert.equal(fs.existsSync(f.sessionFile), false);
    const pending = restored.accept(delivery());
    assert.equal(json(restored.file).pending[pending.id].id, pending.id);
    fs.writeFileSync(f.sessionFile, line(header()) + line(entry(envelope(pending))));
    restored.reconcile(f.receipts().scan());
    assert.equal(f.inbox().accept(delivery()), undefined);
  } finally { restartedOwner.release(); }
});

test('empty binding can rebind an absent planned file for the same session and commits immediately', t => {
  const f = fixture(t, false);
  const firstOwner = new SessionOwner(f.state, SESSION, f.sessionFile);
  let inbox;
  try { inbox = f.inbox(); } finally { firstOwner.release(); }
  const newFile = path.join(f.root, 'new-planned-session.jsonl');
  const owner = new SessionOwner(f.state, SESSION, newFile);
  try {
    const rebound = new DurableInbox(f.state, SESSION, newFile);
    assert.deepEqual(rebound.pending(), []);
    assert.deepEqual(json(inbox.file), { version: 1, sessionId: SESSION, sessionFile: newFile, pending: {}, received: [] });
    assert.equal(fs.existsSync(f.sessionFile), false);
    assert.equal(fs.existsSync(newFile), false);
    assert.equal(json(new DurableInbox(f.state, SESSION, newFile).file).sessionFile, newFile);
  } finally { owner.release(); }
});

for (const history of ['existing old file', 'pending before first user', 'received with old file absent', 'wrong session ID', 'corrupt empty-looking state']) {
  test(`session path rebind fails closed with ${history}`, t => {
    const f = fixture(t, false);
    const inbox = f.inbox();
    // Explicitly seed an empty binding as well, so this negative test is independent
    // of whether initial-constructor persistence is already implemented.
    atomicJson(inbox.file, { version: 1, sessionId: SESSION, sessionFile: f.sessionFile, pending: {}, received: [] });
    if (history === 'existing old file') fs.writeFileSync(f.sessionFile, line(header()));
    if (history === 'pending before first user') inbox.accept(delivery());
    if (history === 'received with old file absent') {
      const pending = inbox.accept(delivery());
      fs.writeFileSync(f.sessionFile, line(header()) + line(entry(envelope(pending))));
      inbox.reconcile(f.receipts().scan());
      fs.unlinkSync(f.sessionFile);
    }
    if (history === 'wrong session ID') atomicJson(inbox.file, { ...json(inbox.file), sessionId: 'different-session' });
    if (history === 'corrupt empty-looking state') atomicJson(inbox.file, { ...json(inbox.file), pending: 123 });
    const before = fs.readFileSync(inbox.file);
    const newFile = path.join(f.root, 'new-planned-session.jsonl');
    assert.throws(() => new DurableInbox(f.state, SESSION, newFile));
    assert.deepEqual(fs.readFileSync(inbox.file), before, 'rejected rebind must preserve the original record');
    assert.equal(fs.existsSync(newFile), false);
  });
}

test('empty binding cannot rebind an inaccessible existing prior session file', {
  skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'Requires non-root POSIX permission checks' : false,
}, t => {
  const f = fixture(t, false);
  const privateDir = path.join(f.root, 'prior-private');
  fs.mkdirSync(privateDir, { mode: 0o700 });
  const priorFile = path.join(privateDir, 'prior-session.jsonl');
  fs.writeFileSync(priorFile, line(header()));
  const inbox = new DurableInbox(f.state, SESSION, priorFile);
  const before = fs.readFileSync(inbox.file);
  fs.chmodSync(privateDir, 0o000);
  try {
    assert.throws(() => fs.statSync(priorFile), { code: 'EACCES' });
    assert.throws(() => new DurableInbox(f.state, SESSION, f.sessionFile), 'inaccessible is not absent');
    assert.deepEqual(fs.readFileSync(inbox.file), before);
  } finally { fs.chmodSync(privateDir, 0o700); }
});

test('durable received IDs survive session rewrite/compaction even when the scanner cache resets', t => {
  const f = fixture(t);
  const inbox = f.inbox();
  const pending = inbox.accept(delivery());
  f.append(entry(envelope(pending)));
  const receipts = f.receipts();
  inbox.reconcile(receipts.scan());
  const replacement = path.join(f.root, 'compacted-session.jsonl');
  fs.writeFileSync(replacement, line(header()) + line({ type: 'compaction', summary: 'delivery summarized' }));
  fs.renameSync(replacement, f.sessionFile);
  inbox.reconcile(receipts.scan());
  assert.equal(inbox.accept(delivery()), undefined);
  assert.equal(f.inbox().accept(delivery()), undefined);
  assert.deepEqual(json(inbox.file).received, [pending.id]);
});

test('absent initial session file is not an in-memory receipt', t => {
  const f = fixture(t, false);
  const receipts = f.receipts();
  const inbox = f.inbox();
  const pending = inbox.accept(delivery());
  inbox.reconcile(receipts.scan());
  assert.deepEqual(inbox.pending(), [pending]);
  fs.writeFileSync(f.sessionFile, line(header()) + line(entry(envelope(pending))));
  inbox.reconcile(receipts.scan());
  assert.deepEqual(inbox.pending(), []);
});

test('partial lines including split UTF-8 are not receipts until newline arrives', t => {
  const f = fixture(t);
  const id = deliveryId(SESSION, delivery());
  const bytes = Buffer.from(line(entry(marker(id) + '\n🌍 café')));
  const split = bytes.indexOf(Buffer.from('🌍')) + 2;
  const receipts = f.receipts();
  fs.appendFileSync(f.sessionFile, bytes.subarray(0, split));
  assert.equal(receipts.scan().size, 0);
  fs.appendFileSync(f.sessionFile, bytes.subarray(split, -1));
  assert.equal(receipts.scan().size, 0);
  fs.appendFileSync(f.sessionFile, bytes.subarray(-1));
  assert.deepEqual([...receipts.scan()], [id]);
});

test('bounded 64KiB reads preserve UTF-8 and long JSONL records across chunks', t => {
  const f = fixture(t);
  const id = deliveryId(SESSION, delivery());
  const prefix = line(header());
  const base = JSON.stringify(entry(marker(id) + '\n'));
  const textStart = base.indexOf('"content":') + '"content":"'.length;
  const encodedMarkerLength = JSON.stringify(marker(id) + '\n').length - 2;
  const padding = 65536 - Buffer.byteLength(prefix) - textStart - encodedMarkerLength - 2;
  const record = line(entry(marker(id) + '\n' + 'x'.repeat(padding) + '🌍' + 'é'.repeat(80000)));
  const whole = Buffer.from(prefix + record);
  assert.equal(whole.indexOf(Buffer.from('🌍')), 65534, 'emoji crosses the first chunk boundary');
  fs.writeFileSync(f.sessionFile, whole);
  assert.deepEqual([...f.receipts().scan()], [id]);
});

test('wrong session identity and corrupt JSONL fail closed', t => {
  const f = fixture(t);
  fs.writeFileSync(f.sessionFile, line(header('different-session')));
  assert.throws(() => f.receipts().scan(), /identity/i);
  fs.writeFileSync(f.sessionFile, line(header()) + '{corrupted record}\n');
  assert.throws(() => f.receipts().scan());
});

test('a corrupt complete JSONL record must remain fail-closed on every scan', t => {
  const f = fixture(t);
  const id = deliveryId(SESSION, delivery());
  f.append(entry(marker(id)));
  fs.appendFileSync(f.sessionFile, '{broken}\n');
  const receipts = f.receipts();
  assert.throws(() => receipts.scan());
  assert.throws(() => receipts.scan(), 'the first failed scan must not advance past corruption');
});

for (const change of ['rename replacement', 'truncate']) {
  test(`DiskReceipts forgets receipts no longer on disk after ${change}`, t => {
    const f = fixture(t);
    const oldId = deliveryId(SESSION, delivery(1));
    const newId = deliveryId(SESSION, delivery(2));
    f.append(entry(marker(oldId) + '\n' + 'padding'.repeat(100)));
    const receipts = f.receipts();
    assert.deepEqual([...receipts.scan()], [oldId]);
    const replacement = line(header()) + line(entry(marker(newId)));
    if (change === 'truncate') fs.writeFileSync(f.sessionFile, replacement);
    else { const file = path.join(f.root, 'replacement'); fs.writeFileSync(file, replacement); fs.renameSync(file, f.sessionFile); }
    assert.deepEqual([...receipts.scan()], [newId], 'cached receipt is not evidence in the replacement file');
  });
}

test('session file replacement with a different identity is rejected', t => {
  const f = fixture(t);
  const receipts = f.receipts(); receipts.scan();
  const replacement = path.join(f.root, 'replacement');
  fs.writeFileSync(replacement, line(header('wrong-session')));
  fs.renameSync(replacement, f.sessionFile);
  assert.throws(() => receipts.scan(), /identity/i);
});

test('corrupt inbox JSON, identity, hashes and receipt IDs fail closed without replacement', async t => {
  const f = fixture(t);
  const inbox = f.inbox(); const pending = inbox.accept(delivery());
  const valid = json(inbox.file);
  const invalidStates = [
    '{bad-json', null,
    { ...valid, version: 2 }, { ...valid, sessionId: 'different' }, { ...valid, sessionFile: path.join(f.root, 'other.jsonl') },
    { ...valid, pending: [] }, { ...valid, pending: 123 }, { ...valid, pending: '' },
    { ...valid, received: ['bad-id'] }, { ...valid, received: [null] },
    { ...valid, pending: { [pending.id]: null } },
    { ...valid, pending: { [pending.id]: { ...pending, id: 'f'.repeat(64) } } },
    { ...valid, pending: { [pending.id]: { ...pending, meta: { ...pending.meta, seq: '99' } } } },
    { ...valid, pending: { [pending.id]: { ...pending, content: null } } },
    { ...valid, pending: { [pending.id]: { ...pending, createdAt: null } } },
  ];
  for (const [index, state] of invalidStates.entries()) {
    await t.test(`invalid record ${index}`, () => {
      const text = typeof state === 'string' ? state : JSON.stringify(state);
      fs.writeFileSync(inbox.file, text);
      assert.throws(() => f.inbox(), `must reject ${text}`);
      assert.equal(fs.readFileSync(inbox.file, 'utf8'), text);
    });
  }
});

test('unsafe session IDs and invalid session paths are rejected before creating owner/inbox', t => {
  const f = fixture(t);
  for (const id of ['../escape', '', '.', '..', '/absolute', 'id/child', 'id\\child']) {
    assert.throws(() => new SessionOwner(f.state, id, f.sessionFile));
    assert.throws(() => new DurableInbox(f.state, id, f.sessionFile));
  }
  for (const file of ['', 'relative.jsonl', f.root]) {
    assert.throws(() => new SessionOwner(f.state, SESSION, file), `owner must reject ${file}`);
    assert.throws(() => new DurableInbox(f.state, SESSION, file), `inbox must reject ${file}`);
  }
  assert.deepEqual(fs.readdirSync(f.state), []);
});

test('owner acquisition is private/exclusive and release permits same-session restart', t => {
  const f = fixture(t);
  const newState = path.join(f.root, 'new-state');
  const owner = new SessionOwner(newState, SESSION, f.sessionFile);
  t.after(() => owner.release());
  if (process.platform !== 'win32') { assert.equal(mode(newState), 0o700); assert.equal(mode(owner.file), 0o600); }
  const record = json(owner.file);
  assert.equal(record.pid, process.pid); assert.equal(record.host, os.hostname());
  assert.equal(record.sessionFile, f.sessionFile); assert.ok(record.nonce);
  assert.throws(() => new SessionOwner(newState, SESSION, f.sessionFile), /owned/i);
  assert.throws(() => new SessionOwner(newState, SESSION, path.join(f.root, 'other-session')), /owned/i);
  owner.release(); owner.release();
  assert.equal(fs.existsSync(owner.file), false);
  const next = new SessionOwner(newState, SESSION, f.sessionFile); next.release();
});

test('release never deletes a replacement owner nonce', t => {
  const f = fixture(t);
  const owner = new SessionOwner(f.state, SESSION, f.sessionFile);
  const replacement = { ...json(owner.file), nonce: 'replacement-owner' };
  atomicJson(owner.file, replacement);
  owner.release(); owner.release();
  assert.deepEqual(json(owner.file), replacement);
});

test('unknown, remote and corrupt owners fail closed without modifying the lock', t => {
  const f = fixture(t);
  const file = path.join(f.state, `pi-${SESSION}.owner`);
  const base = { pid: process.pid, host: os.hostname(), nonce: 'existing', sessionFile: f.sessionFile };
  for (const value of ['{bad-json', 'null', JSON.stringify({ ...base, host: `${os.hostname()}-foreign` }), JSON.stringify({ ...base, pid: 0 }), JSON.stringify({ ...base, pid: '123' }), JSON.stringify({ ...base, nonce: null })]) {
    fs.writeFileSync(file, value);
    assert.throws(() => new SessionOwner(f.state, SESSION, f.sessionFile));
    assert.equal(fs.readFileSync(file, 'utf8'), value);
  }
});

test('stale PID recovery only uses an owned child which exited normally; live child/process conflict is retained', t => {
  const f = fixture(t);
  const file = path.join(f.state, `pi-${SESSION}.owner`);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const pid = Number(child.stdout); assert.ok(Number.isInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); // probe only, never kill.
  atomicJson(file, { pid, host: os.hostname(), nonce: 'dead-child', sessionFile: f.sessionFile });
  const owner = new SessionOwner(f.state, SESSION, f.sessionFile);
  t.after(() => owner.release());
  assert.equal(json(file).pid, process.pid);
  assert.notEqual(json(file).nonce, 'dead-child');
  const moduleUrl = new URL('./durable.ts', import.meta.url).href;
  const contender = spawnSync(process.execPath, ['--input-type=module', '-e', `import { SessionOwner } from ${JSON.stringify(moduleUrl)}; try { new SessionOwner(...JSON.parse(process.argv[1])); process.exit(2); } catch (e) { if (!/owned/i.test(e.message)) throw e; }`, JSON.stringify([f.state, SESSION, f.sessionFile])], { encoding: 'utf8' });
  assert.equal(contender.status, 0, contender.stderr);
  assert.equal(json(file).pid, process.pid);
});

test('interrupted acquisition guard is never stolen, even if its recorded PID is stale', t => {
  const f = fixture(t);
  const file = path.join(f.state, `pi-${SESSION}.owner`);
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const record = { pid: Number(child.stdout), host: os.hostname(), nonce: 'interrupted', sessionFile: f.sessionFile };
  const bytes = line(record);
  fs.writeFileSync(`${file}.guard`, bytes, { mode: 0o600 });
  assert.throws(() => new SessionOwner(f.state, SESSION, f.sessionFile), /acquisition|guard|interrupted/i);
  assert.equal(fs.readFileSync(`${file}.guard`, 'utf8'), bytes);
  assert.equal(fs.existsSync(file), false);
});

test('concurrent stale-owner recovery has exactly one owner; losers cannot unlink the winner', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const file = path.join(f.state, `pi-${SESSION}.owner`);
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  assert.equal(dead.status, 0, dead.stderr);
  const stalePid = Number(dead.stdout);
  assert.throws(() => process.kill(stalePid, 0), { code: 'ESRCH' });
  atomicJson(file, { pid: stalePid, host: os.hostname(), nonce: 'stale', sessionFile: f.sessionFile });
  const moduleUrl = new URL('./durable.ts', import.meta.url).href;
  const worker = `
    import fs from 'node:fs';
    import { setTimeout as sleep } from 'node:timers/promises';
    import { SessionOwner, atomicJson } from ${JSON.stringify(moduleUrl)};
    const [root, state, id, sessionFile, n] = JSON.parse(process.argv[1]);
    const deadline = Date.now() + 10000;
    fs.writeFileSync(root + '/ready-' + n, '');
    while (!fs.existsSync(root + '/go') && Date.now() < deadline) await sleep(5);
    let owner, result;
    try { owner = new SessionOwner(state, id, sessionFile); result = { acquired: true, pid: process.pid }; }
    catch (e) { result = { acquired: false, error: e.message }; }
    atomicJson(root + '/result-' + n, result);
    while (!fs.existsSync(root + '/stop') && Date.now() < deadline) await sleep(5);
    owner?.release();
  `;
  const workers = Array.from({ length: 8 }, (_, n) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker, JSON.stringify([f.root, f.state, SESSION, f.sessionFile, n])], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, stderr })));
    return { child, exited };
  });
  const waitFiles = async prefix => {
    const deadline = Date.now() + 8000;
    while (!workers.every((_, n) => fs.existsSync(path.join(f.root, `${prefix}-${n}`)))) {
      assert.ok(Date.now() < deadline, `timed out waiting for ${prefix}`);
      await sleep(10);
    }
  };
  try {
    await waitFiles('ready');
    fs.writeFileSync(path.join(f.root, 'go'), '');
    await waitFiles('result');
    const results = workers.map((_, n) => json(path.join(f.root, `result-${n}`)));
    const winners = results.filter(r => r.acquired);
    assert.equal(winners.length, 1, JSON.stringify(results));
    assert.equal(json(file).pid, winners[0].pid);
    for (const loser of results.filter(r => !r.acquired)) assert.match(loser.error, /owned|acquisition|guard/i);
    assert.equal(fs.existsSync(`${file}.guard`), false);
  } finally {
    fs.writeFileSync(path.join(f.root, 'stop'), '');
    for (const result of await Promise.all(workers.map(w => w.exited))) assert.equal(result.code, 0, result.stderr);
  }
  assert.equal(fs.existsSync(file), false, 'winner releases ownership when normally stopped');
});
