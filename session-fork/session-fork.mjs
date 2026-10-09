#!/usr/bin/env node
// Fork a Claude Code session log into a new, edited session that `claude --resume <id>` can load.
// CLM idea (context as a file the model edits), applied offline: `mirror` prints the
// session as numbered turns, the agent writes an edit plan, `fork` writes a new session.
// The source log is never modified.
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const PROJECTS = join(homedir(), '.claude', 'projects');
const STATE = join(homedir(), '.local', 'state', 'issue-channel');
const CHAIN_TYPES = new Set(['user', 'assistant', 'attachment', 'system']);
const KEEP_META = new Set(['mode', 'permission-mode', 'atis-latch']);

export function findLog(id) {
  if (existsSync(id)) return id;
  for (const dir of readdirSync(PROJECTS)) {
    const p = join(PROJECTS, dir, `${id}.jsonl`);
    if (existsSync(p)) return p;
  }
  throw new Error(`session log not found: ${id}`);
}

export function readLog(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const isToolResult = (e) =>
  e.type === 'user' && Array.isArray(e.message?.content) && e.message.content.some((c) => c.type === 'tool_result');
const isTurnStart = (e) => e.type === 'user' && !isToolResult(e) && !e.isSidechain;

// Main chain: walk parentUuid back from the last chain entry.
export function mainChain(entries) {
  const byId = new Map(entries.filter((e) => e.uuid).map((e) => [e.uuid, e]));
  const last = [...entries].reverse().find((e) => CHAIN_TYPES.has(e.type) && e.uuid && !e.isSidechain);
  const chain = [];
  for (let e = last; e; e = e.parentUuid ? byId.get(e.parentUuid) : null) chain.push(e);
  return chain.reverse();
}

// Turns: turn 0 is the preamble before the first prompt; each later turn starts at a prompt.
export function splitTurns(chain) {
  const turns = [{ index: 0, entries: [] }];
  for (const e of chain) {
    if (isTurnStart(e)) turns.push({ index: turns.length, entries: [] });
    turns.at(-1).entries.push(e);
  }
  return turns;
}

const text = (content) =>
  typeof content === 'string' ? content : (content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ').trim();
const approxTokens = (entries) => Math.round(entries.reduce((n, e) => n + JSON.stringify(e.message ?? e.attachment ?? '').length, 0) / 4);

// A turn is complete when every tool_use has a matching tool_result.
function isComplete(turn) {
  const uses = new Set(), results = new Set();
  for (const e of turn.entries) {
    for (const c of Array.isArray(e.message?.content) ? e.message.content : []) {
      if (c.type === 'tool_use') uses.add(c.id);
      if (c.type === 'tool_result') results.add(c.tool_use_id);
    }
  }
  return [...uses].every((id) => results.has(id));
}

export function mirror(turns) {
  const out = [];
  for (const t of turns) {
    const first = t.entries.find(isTurnStart);
    const from = first?.origin?.kind ?? (t.index === 0 ? 'preamble' : 'user');
    const tools = {};
    let reply = '';
    for (const e of t.entries) {
      if (e.type !== 'assistant') continue;
      for (const c of e.message.content) {
        if (c.type === 'tool_use') tools[c.name] = (tools[c.name] || 0) + 1;
        if (c.type === 'text') reply = c.text;
      }
    }
    out.push(`[[TURN ${t.index} from=${from} tokens~${approxTokens(t.entries)}${isComplete(t) ? '' : ' incomplete'}]]`);
    if (first) out.push(`user: ${clip(text(first.message.content), 400)}`);
    const toolList = Object.entries(tools).map(([k, v]) => `${k}×${v}`).join(', ');
    if (toolList) out.push(`tools: ${toolList}`);
    if (reply) out.push(`assistant: ${clip(reply, 400)}`);
    out.push('');
  }
  return out.join('\n');
}

// Plan: { ops: [{ op: "replace", from, to, note } | { op: "drop", from, to }], note?, title? }
// Turn ranges are inclusive. "replace" puts one synthetic user note (plus a short assistant
// ack, to keep roles alternating) where the turns were. Turn 0 (preamble) can't be edited.
// Incomplete turns (an unanswered tool_use, e.g. the turn running the fork) are always dropped.
// A top-level "note" is appended as the last message, e.g. a handoff for the successor.
export function applyPlan(turns, plan, sessionId) {
  const action = new Map();
  for (const op of plan.ops || []) {
    if (op.from < 1 || op.to < op.from || op.to >= turns.length) throw new Error(`bad range ${op.from}-${op.to}`);
    for (let i = op.from; i <= op.to; i++) {
      if (action.has(i)) throw new Error(`turn ${i} is edited twice`);
      action.set(i, i === op.from ? op : { op: 'skip' });
    }
  }
  const proto = turns.flatMap((t) => t.entries).find((e) => e.type === 'assistant');
  const base = turns.flatMap((t) => t.entries).find((e) => e.type === 'user');
  const out = [];
  const push = (e) => out.push({ ...e, sessionId, ...(e.session_id ? { session_id: sessionId } : {}) });
  const synth = (note) => {
    const ts = new Date().toISOString();
    const common = { cwd: base.cwd, gitBranch: base.gitBranch, version: base.version, entrypoint: base.entrypoint, userType: base.userType, isSidechain: false, timestamp: ts };
    push({ ...common, type: 'user', uuid: randomUUID(), message: { role: 'user', content: `[Context note written while editing this session's history]\n\n${note}` } });
    push({
      ...common, type: 'assistant', uuid: randomUUID(), requestId: undefined,
      message: { id: `msg_fork_${randomUUID().replace(/-/g, '')}`, type: 'message', role: 'assistant', model: proto?.message?.model, content: [{ type: 'text', text: 'Noted.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
  };
  for (const t of turns) {
    const a = action.get(t.index);
    if (!isComplete(t)) continue;
    if (!a) t.entries.forEach(push);
    else if (a.op === 'replace') synth(a.note);
    else if (a.op !== 'drop' && a.op !== 'skip') throw new Error(`unknown op ${a.op}`);
  }
  if (plan.note) synth(plan.note);
  // Re-link the chain in order; this also bridges every removed span.
  out.forEach((e, i) => { e.parentUuid = i ? out[i - 1].uuid : null; delete e.logicalParentUuid; });
  return out;
}

export function fork(srcPath, plan) {
  const entries = readLog(srcPath);
  const turns = splitTurns(mainChain(entries));
  const id = randomUUID();
  const chain = applyPlan(turns, plan, id);
  const meta = entries.filter((e) => KEEP_META.has(e.type)).slice(0, KEEP_META.size).map((e) => ({ ...e, sessionId: id }));
  const title = { type: 'ai-title', aiTitle: plan.title || `fork of ${entries.find((e) => e.sessionId)?.sessionId?.slice(0, 8)}`, sessionId: id };
  const dest = join(dirname(srcPath), `${id}.jsonl`);
  writeFileSync(dest, [...meta, ...chain, title].map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
  return { id, dest, entries: chain.length, tokens: approxTokens(chain), before: approxTokens(turns.flatMap((t) => t.entries)) };
}

// Copy the issuechan subscriptions (and cursors) of one session to another, so the
// successor resumes from where the parent stopped.
export function handoff(fromId, toId, stateDir = STATE) {
  const src = join(stateDir, `cc-${fromId}.json`);
  if (!existsSync(src)) throw new Error(`no issuechan state for ${fromId}`);
  const dest = join(stateDir, `cc-${toId}.json`);
  copyFileSync(src, dest);
  return dest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === 'mirror') process.stdout.write(mirror(splitTurns(mainChain(readLog(findLog(a))))));
    else if (cmd === 'fork') console.log(JSON.stringify(fork(findLog(a), JSON.parse(readFileSync(b, 'utf8'))), null, 2));
    else if (cmd === 'handoff') console.log(handoff(a, b));
    else {
      console.error('usage: session-fork.mjs mirror <session-id|path>\n       session-fork.mjs fork <session-id|path> <plan.json>\n       session-fork.mjs handoff <from-session-id> <to-session-id>');
      process.exit(2);
    }
  } catch (err) {
    console.error(`session-fork: ${err.message}`);
    process.exit(1);
  }
}
