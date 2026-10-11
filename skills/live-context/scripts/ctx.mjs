#!/usr/bin/env node
// ctx: edit your working context as a file (live context, as in pi-clm), then switch to the edited version.
//   ctx.mjs open                       write the current context to a file; prints its path and size
//   ctx.mjs list                       block headers of that file (ids, kinds, tokens), no bodies
//   ctx.mjs apply [--then T] [--name N] check the edited file and switch to it when this turn ends
//   ctx.mjs report [--from <id>]       after the switch: context size before/after as the API reported it
// Under the hood (Claude Code + herdr): `open` renders the session with session-fork, and `apply`
// runs spawn/restart-agent.sh --fork detached, which forks the session, hands over the issuechan
// state and resumes the fork in the same pane.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, openSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findLog, loadTurns, renderLive, parseLive, applyLive, liveBlocks } from '../../../session-fork/session-fork.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const sid = process.env.CLAUDE_CODE_SESSION_ID;
const pointer = () => join(tmpdir(), `live-context-${sid}.path`);
const die = (m) => { console.error(`ctx: ${m}`); process.exit(1); };
const current = () => {
  if (!existsSync(pointer())) die('no context file yet: run `ctx open` first');
  const file = readFileSync(pointer(), 'utf8').trim();
  if (!existsSync(file)) die(`context file is gone: ${file}; run \`ctx open\` again`);
  return file;
};

const args = process.argv.slice(2);
const opt = (f) => { const i = args.indexOf(f); return i < 0 ? undefined : args.splice(i, 2)[1]; };
if (!sid) die('no session to work on (CLAUDE_CODE_SESSION_ID is not set)');
const cmd = args[0];

if (cmd === 'open') {
  const turns = loadTurns(findLog(sid), { live: true });
  const dir = mkdtempSync(join(tmpdir(), 'live-context-'));
  const file = join(dir, 'CONTEXT.md');
  writeFileSync(file, renderLive(turns, sid), { mode: 0o600 });
  writeFileSync(pointer(), file, { mode: 0o600 });
  const { blocks } = liveBlocks(turns);
  const tokens = blocks.reduce((n, b) => n + Math.round(b.text.length / 4), 0);
  console.log(`Context file: ${file}\n${blocks.length} blocks, ~${tokens} tokens (the current turn is not included).\nEdit it in place (see its first lines), then run: ctx apply`);
} else if (cmd === 'list') {
  for (const line of readFileSync(current(), 'utf8').split('\n')) if (/^\[\[(TURN|BLOCK|NOTE)/.test(line)) console.log(line);
} else if (cmd === 'apply') {
  const file = current();
  // The report needs the first request of the new context, so the resumed agent runs it itself.
  // The new session's first request is written to its log only after it completes, so the report
  // needs one earlier tool call in the new session (any quick one) to have something to measure.
  const report_ = 'After your first tool call in this turn, run `node ~/.claude/skills/live-context/scripts/ctx.mjs report` and include its table, unchanged, wherever you report this switch.';
  const then = `${opt('--then') ?? 'Your working context was just replaced by the edited version from `ctx apply`. Continue where you left off.'}\n\n${report_}`;
  const name = opt('--name');
  // Check now, so a mistake is reported in this turn instead of after the switch.
  let report;
  try { ({ report } = applyLive(loadTurns(findLog(sid), { live: true }), parseLive(readFileSync(file, 'utf8')), 'check', { source: sid })); }
  catch (e) { die(e.message.replace('make one with mirror --full', 'run `ctx open` again').replace('the session changed after mirror --full; make a new one', 'the conversation moved on since `ctx open`; run it again and redo the edit')); }
  if (report.kept === 0 && report.notes === 0) die('this edit leaves nothing (0 blocks kept, no notes); check your edit script, run `ctx open` again and redo it');
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) die('the switch needs a herdr pane (HERDR_PANE_ID is not set)');
  // One pending switch per session: a second apply in the same turn replaces the first. That one is still
  // waiting for the turn to end (nothing forked yet); stop its whole process group.
  const pending = join(tmpdir(), `live-context-${sid}.pending`);
  let replaced = false;
  if (existsSync(pending)) {
    const old = Number(readFileSync(pending, 'utf8'));
    try { process.kill(-old, 'SIGTERM'); replaced = true; } catch {}
  }
  const log = openSync(join(dirname(file), 'apply.log'), 'a');
  // detached: its own session and process group (pgid = child.pid), so a later apply can stop it.
  const child = spawn(join(ROOT, 'spawn/restart-agent.sh'), ['--pane', pane, '--session', sid, '--fork', file, '--then', then, ...(name ? ['--name', name] : [])],
    { detached: true, stdio: ['ignore', log, log] });
  child.unref();
  writeFileSync(pending, String(child.pid), { mode: 0o600 });
  if (replaced) console.log('Replaced the earlier pending switch from this turn.');
  for (const w of report.warnings) console.log(`warning: ${w}`);
  console.log(`Edit accepted: kept ${report.kept} of ${report.blocks} blocks, trimmed ${report.edited}, removed ${report.dropped + report.orphans}, notes ${report.notes}${report.handoff ? ' (summary only)' : ''}.`);
  console.log('The switch happens when this turn ends. Finish the turn now; nothing else to do.');
} else if (cmd === 'report') {
  console.log(switchReport(sid, opt('--from')));
} else {
  console.error('usage: ctx.mjs open | list | apply [--then <text>] [--name <name>] | report [--from <id>]');
  process.exit(2);
}

// Context size as the API billed it: input + cache read + cache write of one request. Copied replies in a
// fork carry no requestId, so the first entry with one is the fork's first real request.
function requestSize(e) {
  const u = e.message?.usage;
  return u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0;
}
function requests(id) {
  return readFileSync(findLog(id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => e.type === 'assistant' && e.requestId && !e.isSidechain && requestSize(e) > 0);
}
// The restart record (restart-agent.sh's JSON line in apply.log) for the switch into session `id`.
function switchRecord(id, from) {
  for (const d of readdirSync(tmpdir()).filter((n) => n.startsWith('live-context-'))) {
    const log = join(tmpdir(), d, 'apply.log');
    if (!existsSync(log)) continue;
    for (const line of readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('{'))) {
      try { const r = JSON.parse(line); if (r.session === id && (!from || r.from === from)) return { ...r, log }; } catch {}
    }
  }
  return from ? { from, session: id } : null;
}
function hkt(t) { return new Date(Date.parse(t) + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ') + ' HKT'; }
export function switchReport(id, from) {
  const rec = switchRecord(id, from);
  if (!rec) die('no switch into this session found (apply.log is gone?); pass --from <previous session id>');
  const before = requests(rec.from).at(-1);
  const after = requests(id)[0];
  if (!before) die(`no API request found in ${rec.from}`);
  const b = requestSize(before), a = after ? requestSize(after) : null;
  const pct = (x, y) => `${x > y ? '−' : '+'}${Math.abs(x - y).toLocaleString('en-US')} (${x > y ? '−' : '+'}${Math.round(Math.abs(x - y) / x * 100)}%)`;
  const e = rec.edit;
  const rows = [
    ['Session', `${rec.from.slice(0, 8)} → ${id.slice(0, 8)}`],
    ['Context before (last request of the old session)', `${b.toLocaleString('en-US')} tokens (${hkt(before.timestamp)})`],
    ['Context after (first request of the new session)', a == null ? 'not measured yet: the new session\'s first request is written to its log only when it completes; run `ctx report` again after one more tool call' : `${a.toLocaleString('en-US')} tokens (${hkt(after.timestamp)})`],
    ...(a == null ? [] : [['Change', pct(b, a)]]),
    ...(e ? [['Edit', `kept ${e.kept}/${e.blocks} blocks, trimmed ${e.edited}, removed ${e.dropped}, notes ${e.notes}${e.handoff ? ' (summary only)' : ''}`]] : []),
    ...(rec.seconds ? [['Switch time', `${rec.seconds} s`]] : []),
  ];
  return ['| Context switch | Value |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    '', 'Token counts are input + cache read + cache write as reported by the API (message usage), not estimates.'].join('\n');
}
