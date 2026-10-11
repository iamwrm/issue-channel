#!/usr/bin/env node
// ctx: edit your working context as a file (live context, as in pi-clm), then switch to the edited version.
//   ctx.mjs open                       write the current context to a file; prints its path and size
//   ctx.mjs list                       block headers of that file (ids, kinds, tokens), no bodies
//   ctx.mjs apply [--then T] [--name N] check the edited file and switch to it when this turn ends
// Under the hood (Claude Code + herdr): `open` renders the session with session-fork, and `apply`
// runs spawn/restart-agent.sh --fork detached, which forks the session, hands over the issuechan
// state and resumes the fork in the same pane.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, openSync } from 'node:fs';
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
  const then = opt('--then') ?? 'Your working context was just replaced by the edited version from `ctx apply`. Continue where you left off.';
  const name = opt('--name');
  // Check now, so a mistake is reported in this turn instead of after the switch.
  let report;
  try { ({ report } = applyLive(loadTurns(findLog(sid), { live: true }), parseLive(readFileSync(file, 'utf8')), 'check', { source: sid })); }
  catch (e) { die(e.message.replace('make one with mirror --full', 'run `ctx open` again').replace('the session changed after mirror --full; make a new one', 'the conversation moved on since `ctx open`; run it again and redo the edit')); }
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) die('the switch needs a herdr pane (HERDR_PANE_ID is not set)');
  const log = openSync(join(dirname(file), 'apply.log'), 'a');
  const child = spawn('setsid', [join(ROOT, 'spawn/restart-agent.sh'), '--pane', pane, '--session', sid, '--fork', file, '--then', then, ...(name ? ['--name', name] : [])],
    { detached: true, stdio: ['ignore', log, log] });
  child.unref();
  for (const w of report.warnings) console.log(`warning: ${w}`);
  console.log(`Edit accepted: kept ${report.kept} of ${report.blocks} blocks, trimmed ${report.edited}, removed ${report.dropped + report.orphans}, notes ${report.notes}${report.handoff ? ' (summary only)' : ''}.`);
  console.log('The switch happens when this turn ends. Finish the turn now; nothing else to do.');
} else {
  console.error('usage: ctx.mjs open | list | apply [--then <text>] [--name <name>]');
  process.exit(2);
}
