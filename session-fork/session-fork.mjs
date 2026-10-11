#!/usr/bin/env node
// Fork a Claude Code session log into a new, edited session that `claude --resume <id>` can load.
// CLM idea (context as a file the model edits), applied offline: `mirror` prints the
// session as numbered turns, the agent writes an edit plan, `fork` writes a new session.
// The source log is never modified.
import { isMain } from '../core/entrypoint.mjs'
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

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
// Text Claude Code injects inside a turn (a loaded skill's body: isMeta + sourceToolUseID) is not a new prompt.
const isTurnStart = (e) => e.type === 'user' && !isToolResult(e) && !e.isSidechain && !e.isMeta && !e.sourceToolUseID;

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

// An agent that forks its own live session is still inside its last turn. That turn can look
// complete: its earlier tool calls have results, and the call running the fork isn't logged yet.
export const isOwnSession = (path, self = process.env.CLAUDE_CODE_SESSION_ID) =>
  Boolean(self) && path.endsWith(`/${self}.jsonl`);

export function loadTurns(path, { live = isOwnSession(path) } = {}) {
  const turns = splitTurns(mainChain(readLog(path)));
  if (live && turns.length > 1) turns.at(-1).running = true;
  return turns;
}

// A turn is complete when every tool_use has a matching tool_result and it isn't still running.
function isComplete(turn) {
  if (turn.running) return false;
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
    const flag = t.running ? ' running' : isComplete(t) ? '' : ' incomplete';
    out.push(`[[TURN ${t.index} from=${from} tokens~${approxTokens(t.entries)}${flag}]]`);
    if (first) out.push(`user: ${clip(text(first.message.content), 400)}`);
    const toolList = Object.entries(tools).map(([k, v]) => `${k}×${v}`).join(', ');
    if (toolList) out.push(`tools: ${toolList}`);
    if (reply) out.push(`assistant: ${clip(reply, 400)}`);
    out.push('');
  }
  return out.join('\n');
}

const zeroNumbers = (v) =>
  typeof v === 'number' ? 0
    : Array.isArray(v) ? v.map(zeroNumbers)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, zeroNumbers(x)]))
      : v;

// Plan: { ops: [{ op: "replace", from, to, note } | { op: "drop", from, to }], note?, title? }
// Turn ranges are inclusive. "replace" puts one synthetic user note (plus a short assistant
// ack, to keep roles alternating) where the turns were. Turn 0 (preamble) can't be edited.
// Incomplete turns (an unanswered tool_use, or the running last turn of your own session) are always dropped.
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
  // Copied replies were already billed to the parent. Without a requestId and with zero usage,
  // usage tools such as ccusage count them as 0 here and keep crediting them to the parent.
  const pushCopy = (e) => {
    if (e.type !== 'assistant' || !e.message?.usage) return push(e);
    const { requestId, ...rest } = e;
    push({ ...rest, message: { ...e.message, usage: zeroNumbers(e.message.usage) } });
  };
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
    if (!a) t.entries.forEach(pushCopy);
    else if (a.op === 'replace') synth(a.note);
    else if (a.op !== 'drop' && a.op !== 'skip') throw new Error(`unknown op ${a.op}`);
  }
  if (plan.note) synth(plan.note);
  // Re-link the chain in order; this also bridges every removed span.
  out.forEach((e, i) => { e.parentUuid = i ? out[i - 1].uuid : null; delete e.logicalParentUuid; });
  return out;
}

// ---- Live context: the full session as an editable file (CLM's LIVE_CONTEXT, for Claude Code) ----
// `mirror --full` renders every content block of every complete turn as [[BLOCK id kind=…]] + its text.
// The agent edits that file in its OLD session (it still has the whole context and its reasoning),
// then `fork` applies the edited file. Rules, from POC runs against Claude Code 2.1.284 / Opus 5.5:
// - thinking is opaque: its signature is the real content (a rewritten text is accepted and ignored),
//   so it can be kept or deleted, never edited. Its text is never rendered (a placeholder is shown).
// - an orphaned tool_result is dropped by Claude Code anyway; here it is dropped explicitly and
//   reported. Deleting a tool_use takes its result with it; deleting only a result leaves a stub.
// - an edited tool output gets a visible trim marker, so the model doesn't take it for a contradiction.
// - notes are plain user entries placed exactly where written (consecutive user messages merge).
// - attachments follow their turn: kept while it keeps any block, dropped with it otherwise.
const MARK = /^\[\[(LIVE_CONTEXT|TURN|BLOCK|NOTE|END)\b([^\]]*)\]\]/;
const escapeLine = (l) => (/^\\*\[\[/.test(l) ? `\\${l}` : l);
const unescapeLine = (l) => (/^\\+\[\[/.test(l) ? l.slice(1) : l);
const trimNl = (s) => s.replace(/\n+$/, '');
const tok = (s) => Math.round(s.length / 4);
const STUB = '(output removed when the context was edited)';

const partText = (c) =>
  typeof c === 'string' ? c
    : (c || []).map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join('\n');

// One block per content item (Claude Code logs one item per entry; arrays are handled anyway).
function blocksOf(entry, turnStart) {
  const m = entry.message;
  // Attachments and system entries (reminders, tool lists, prompt snapshots) are not blocks:
  // they stay while their turn keeps any block and go with it otherwise (Claude Code re-announces them).
  if (!m) return [];
  if (typeof m.content === 'string') return [{ kind: turnStart ? 'prompt' : 'user', k: -1, text: m.content }];
  return m.content.map((c, k) => {
    if (c.type === 'text') return { kind: turnStart ? 'prompt' : entry.type === 'assistant' ? 'text' : 'user', k, text: c.text };
    // Never render reasoning text: the mirror is read back by the model, and raw reasoning stays private.
    if (c.type === 'thinking') return { kind: 'thinking', k, opaque: true, text: '(reasoning block: keep or delete)' };
    if (c.type === 'redacted_thinking') return { kind: 'thinking', k, opaque: true, text: '(reasoning block: keep or delete)' };
    if (c.type === 'tool_use') return { kind: 'tool_use', k, id: c.id, name: c.name, text: `${c.name} ${JSON.stringify(c.input)}` };
    if (c.type === 'tool_result') return { kind: 'tool_result', k, for: c.tool_use_id, text: partText(c.content) };
    return { kind: c.type, k, opaque: true, text: clip(JSON.stringify(c), 300) };
  });
}

// Blocks of the editable turns: complete and not running (the running turn is the one editing).
export function liveBlocks(turns) {
  const blocks = [], skipped = [], uuids = [];
  let n = 0;
  for (const t of turns) {
    if (!isComplete(t)) { skipped.push(t); continue; }
    for (const e of t.entries) {
      uuids.push(e.uuid);
      for (const b of blocksOf(e, isTurnStart(e))) blocks.push({ ...b, bid: `b${String(++n).padStart(4, '0')}`, turn: t.index, uuid: e.uuid });
    }
  }
  const digest = createHash('sha256').update(uuids.join('\n')).digest('hex').slice(0, 16);
  return { blocks, skipped, digest };
}

const HOWTO = `How to edit (this preamble is ignored):
- Each [[BLOCK …]] is one message part: a request, a reply, a tool call, a tool output or a reasoning block.
- Delete a whole block (header and text) to remove it; edit its text to shorten or rewrite it.
- Reasoning blocks (kind=thinking) can only be kept or deleted.
- kind=tool_use: keep "<name> <json input>"; deleting it also removes its output.
- Add a note anywhere with a line [[NOTE]] followed by its text; prefer turn boundaries.
- Removing everything and leaving one [[NOTE]] is allowed (a plain summary), and reported as such.
- Lines starting with [[ inside a text are escaped with a leading backslash.
`;

export function renderLive(turns, sessionId) {
  const { blocks, skipped, digest } = liveBlocks(turns);
  const self = turns.some((t) => t.running) ? 1 : 0; // made from inside the session: its running turn is left out
  const out = [`[[LIVE_CONTEXT session=${sessionId} digest=${digest} self=${self} blocks=${blocks.length} tokens~${tok(blocks.map((b) => b.text).join(''))}]]`, HOWTO];
  let turn = -1;
  for (const b of blocks) {
    if (b.turn !== turn) {
      turn = b.turn;
      const att = turns[turn].entries.filter((e) => !e.message);
      out.push(`[[TURN ${turn}]]${att.length ? ` (+${att.length} attachments ~${approxTokens(att)} tokens: kept while this turn keeps a block)` : ''}`);
    }
    const attrs = [`kind=${b.kind}`, b.name && `name=${b.name}`, b.for && `for=${blocks.find((x) => x.id === b.for)?.bid ?? b.for}`, b.opaque && 'keep-or-delete', `tokens~${tok(b.text)}`];
    out.push(`[[BLOCK ${b.bid} ${attrs.filter(Boolean).join(' ')}]]`, ...b.text.split('\n').map(escapeLine), '');
  }
  for (const t of skipped) out.push(`[[TURN ${t.index}]] (${t.running ? 'running: the turn doing this edit' : 'incomplete'}; always dropped)`);
  out.push('[[END]]', '');
  return out.join('\n');
}

export function parseLive(src) {
  const lines = src.split('\n');
  const head = lines[0].match(/^\[\[LIVE_CONTEXT session=(\S+) digest=(\S+)/);
  if (!head) throw new Error('not a live-context file (first line must be [[LIVE_CONTEXT …]]; make one with mirror --full)');
  const items = [];
  let cur = null;
  for (const line of lines.slice(1)) {
    const m = line.match(MARK);
    if (m) {
      cur = null;
      if (m[1] === 'BLOCK') items.push(cur = { type: 'block', bid: m[2].trim().split(/\s+/)[0], lines: [] });
      else if (m[1] === 'NOTE') items.push(cur = { type: 'note', lines: [] });
      if (m[1] === 'END') break;
    } else if (cur) cur.lines.push(unescapeLine(line));
  }
  for (const it of items) it.text = trimNl(it.lines.join('\n'));
  return { session: head[1], digest: head[2], items };
}

// Apply an edited live-context file. Returns the new chain plus a report of every change.
export function applyLive(turns, live, sessionId, { source, keepLast = false } = {}) {
  const { blocks, digest } = liveBlocks(turns);
  if (source && live.session !== source) throw new Error(`live-context is for session ${live.session}, not ${source}`);
  if (live.digest !== digest) throw new Error('live-context is stale: the session changed after mirror --full; make a new one');
  const byBid = new Map(blocks.map((b) => [b.bid, b]));
  const kept = new Map(), notesAfter = new Map(), warnings = [];
  let prev = null;
  for (const it of live.items) {
    if (it.type === 'note') { if (!notesAfter.has(prev)) notesAfter.set(prev, []); notesAfter.get(prev).push(it.text); continue; }
    const b = byBid.get(it.bid);
    if (!b) throw new Error(`unknown block ${it.bid}`);
    if (kept.has(it.bid)) throw new Error(`block ${it.bid} appears twice`);
    const edited = it.text !== trimNl(b.text);
    if (edited && b.opaque) throw new Error(`block ${it.bid} (${b.kind}) can only be kept or deleted, not edited`);
    if (edited && b.kind === 'tool_use') {
      const sp = it.text.indexOf(' ');
      if (it.text.slice(0, sp) !== b.name) throw new Error(`block ${it.bid}: keep the tool name ${b.name}`);
      try { JSON.parse(it.text.slice(sp + 1)); } catch { throw new Error(`block ${it.bid}: the tool input is not valid JSON`); }
    }
    kept.set(it.bid, { text: it.text, edited });
    prev = it.bid;
  }
  const keptUses = new Set(blocks.filter((b) => b.kind === 'tool_use' && kept.has(b.bid)).map((b) => b.id));
  const report = { blocks: blocks.length, kept: 0, edited: 0, dropped: 0, orphans: 0, stubs: 0, structural: 0, notes: live.items.filter((i) => i.type === 'note').length, warnings, changes: [] };
  for (const t of new Set(blocks.map((b) => b.turn))) {
    const tb = blocks.filter((b) => b.turn === t);
    const prompt = tb.find((b) => b.kind === 'prompt');
    if (prompt && !kept.has(prompt.bid) && tb.some((b) => kept.has(b.bid)))
      warnings.push(`turn ${t}: prompt ${prompt.bid} deleted but replies kept; the model will notice the gap`);
    if (prompt && kept.has(prompt.bid) && !tb.some((b) => b !== prompt && kept.has(b.bid)))
      warnings.push(`turn ${t}: prompt ${prompt.bid} kept but every reply deleted; the model will think it never answered (delete both, or add a NOTE)`);
  }

  const base = turns.flatMap((t) => t.entries).find((e) => e.type === 'user');
  const out = [];
  const push = (e) => out.push({ ...e, sessionId, ...(e.session_id ? { session_id: sessionId } : {}) });
  const pushCopy = (e) => {
    if (e.type !== 'assistant' || !e.message?.usage) return push(e);
    const { requestId, ...rest } = e;
    push({ ...rest, message: { ...e.message, usage: zeroNumbers(e.message.usage) } });
  };
  const note = (text) => push({
    cwd: base.cwd, gitBranch: base.gitBranch, version: base.version, entrypoint: base.entrypoint, userType: base.userType,
    isSidechain: false, timestamp: new Date().toISOString(), type: 'user', uuid: randomUUID(),
    message: { role: 'user', content: `[Context note written while editing this session's history]\n\n${text}` },
  });
  (notesAfter.get(null) || []).forEach(note);
  const blocksByUuid = Map.groupBy(blocks, (b) => b.uuid);
  for (const t of turns) {
    if (!isComplete(t)) {
      if (keepLast && t.running && isComplete({ ...t, running: false })) t.entries.forEach(pushCopy);
      continue;
    }
    const keepsAny = t.index === 0 || blocks.some((b) => b.turn === t.index && kept.has(b.bid));
    for (const e of t.entries) {
      const eb = blocksByUuid.get(e.uuid) || [];
      if (!eb.length) { if (keepsAny) pushCopy(e); else report.structural++; continue; }
      const content = Array.isArray(e.message?.content) ? [] : null;
      let str = typeof e.message?.content === 'string' ? e.message.content : null, any = false;
      for (const b of eb) {
        const kb = kept.get(b.bid);
        const orig = Array.isArray(e.message?.content) ? e.message.content[b.k] : null;
        if (b.kind === 'tool_result' && !keptUses.has(b.for)) {
          if (kb) { report.orphans++; report.changes.push([b.bid, 'orphan dropped', tok(b.text), 0]); }
          else { report.dropped++; report.changes.push([b.bid, 'dropped', tok(b.text), 0]); }
          continue;
        }
        if (!kb) {
          if (b.kind === 'tool_result') {
            report.stubs++; report.changes.push([b.bid, 'stubbed', tok(b.text), tok(STUB)]);
            content.push({ ...orig, content: STUB }); any = true;
          } else { report.dropped++; report.changes.push([b.bid, 'dropped', tok(b.text), 0]); }
          continue;
        }
        any = true; report.kept++;
        if (!kb.edited) { if (content) content.push(orig); continue; }
        report.edited++;
        let text = kb.text;
        if (b.kind === 'tool_result') text = `${text}\n[trimmed when the context was edited: ${b.text.length} → ${kb.text.length} chars]`;
        report.changes.push([b.bid, 'edited', tok(b.text), tok(text)]);
        if (str !== null) str = text;
        else if (b.kind === 'tool_use') content.push({ ...orig, input: JSON.parse(text.slice(text.indexOf(' ') + 1)) });
        else if (b.kind === 'tool_result') content.push({ ...orig, content: text });
        else content.push({ ...orig, text });
      }
      if (any) pushCopy({ ...e, message: { ...e.message, content: str ?? content } });
      for (const b of eb) (notesAfter.get(b.bid) || []).forEach(note);
    }
  }
  out.forEach((e, i) => { e.parentUuid = i ? out[i - 1].uuid : null; delete e.logicalParentUuid; });
  report.handoff = !kept.size;
  return { chain: out, report };
}

export function diffReport(r, before, after) {
  const lines = [
    `# Context edit`, '',
    `| Blocks | Kept | Edited | Dropped | Stubbed | Orphans dropped | Notes | Attachments dropped | Tokens |`,
    `|---|---|---|---|---|---|---|---|---|`,
    `| ${r.blocks} | ${r.kept} | ${r.edited} | ${r.dropped} | ${r.stubs} | ${r.orphans} | ${r.notes} | ${r.structural} | ~${before} → ~${after} |`, '',
  ];
  if (r.handoff) lines.push('**Handoff:** no original block was kept; the new session starts from notes only.', '');
  for (const w of r.warnings) lines.push(`- warning: ${w}`);
  if (r.warnings.length) lines.push('');
  // Collapse runs of the same change into ranges.
  const runs = [];
  for (const [bid, what, a, b] of r.changes) {
    const last = runs.at(-1);
    if (last && last.what === what && what !== 'edited' && +bid.slice(1) === +last.to.slice(1) + 1) { last.to = bid; last.a += a; last.n++; }
    else runs.push({ from: bid, to: bid, what, a, b, n: 1 });
  }
  if (runs.length) lines.push('| Blocks | Change | Tokens |', '|---|---|---|');
  for (const x of runs) lines.push(`| ${x.from === x.to ? x.from : `${x.from}–${x.to} (${x.n})`} | ${x.what} | ${x.what === 'edited' || x.what === 'stubbed' ? `~${x.a} → ~${x.b}` : `−${x.a}`} |`);
  return lines.join('\n') + '\n';
}

export function forkLive(srcPath, liveFile, { keepLast = false, title, ...opts } = {}) {
  const entries = readLog(srcPath);
  const turns = loadTurns(srcPath, opts);
  const id = randomUUID();
  const source = entries.find((e) => e.sessionId)?.sessionId;
  const live = parseLive(readFileSync(liveFile, 'utf8'));
  const { chain, report } = applyLive(turns, live, id, { source, keepLast });
  const meta = entries.filter((e) => KEEP_META.has(e.type)).slice(0, KEEP_META.size).map((e) => ({ ...e, sessionId: id }));
  const titleEntry = { type: 'ai-title', aiTitle: title || `fork of ${source?.slice(0, 8)}`, sessionId: id };
  const dest = join(dirname(srcPath), `${id}.jsonl`);
  writeFileSync(dest, [...meta, ...chain, titleEntry].map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
  const before = approxTokens(turns.flatMap((t) => t.entries)), tokens = approxTokens(chain);
  const diff = liveFile.replace(/(\.md)?$/, '.diff.md');
  writeFileSync(diff, diffReport(report, before, tokens), { mode: 0o600 });
  const { changes, ...counts } = report;
  return { id, dest, entries: chain.length, tokens, before, diff, ...counts };
}

export function fork(srcPath, plan, opts) {
  const entries = readLog(srcPath);
  const turns = loadTurns(srcPath, opts);
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

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (f) => { const i = args.indexOf(f); return i < 0 ? false : (args.splice(i, 1), true); };
  const opt = (f) => { const i = args.indexOf(f); return i < 0 ? undefined : args.splice(i, 2)[1]; };
  const full = flag('--full'), keepLast = flag('--keep-last'), out = opt('--out'), title = opt('--title');
  const [cmd, a, b] = args;
  const USAGE = `usage: session-fork.mjs mirror <session-id|path>                  numbered turns (an index)
       session-fork.mjs mirror --full <session-id|path> [--out F]   the editable live context
       session-fork.mjs fork <session-id|path> <live-context.md> [--keep-last] [--title T]
       session-fork.mjs fork <session-id|path> <plan.json>          turn-level plan (dispatch)
       session-fork.mjs handoff <from-session-id> <to-session-id>`;
  try {
    if (cmd === 'mirror' && full) {
      const path = findLog(a);
      const text = renderLive(loadTurns(path), readLog(path).find((e) => e.sessionId)?.sessionId);
      if (out) { writeFileSync(out, text, { mode: 0o600 }); console.log(out); } else process.stdout.write(text);
    } else if (cmd === 'mirror') process.stdout.write(mirror(loadTurns(findLog(a))));
    else if (cmd === 'fork' && b && readFileSync(b, 'utf8').startsWith('[[LIVE_CONTEXT')) console.log(JSON.stringify(forkLive(findLog(a), b, { keepLast, title }), null, 2));
    else if (cmd === 'fork' && b) console.log(JSON.stringify(fork(findLog(a), JSON.parse(readFileSync(b, 'utf8'))), null, 2));
    else if (cmd === 'handoff') console.log(handoff(a, b));
    else { console.error(USAGE); process.exit(2); }
  } catch (err) {
    console.error(`session-fork: ${err.message}`);
    process.exit(1);
  }
}
