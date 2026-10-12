#!/usr/bin/env node
// The `/bot !no-compact` swap, started DETACHED by the Claude Code channel (adapters/claude-code/adapter.mjs):
//   no-compact.mjs <request.json>   {repo, issue, session, pane, from, then, comment_id, reply_to}
// Runs restart-agent.sh --no-compact (wait idle → session-fork reset → /exit → handoff → resume the reset fork in
// the same pane → type `then`), then posts the outcome on the issue from code. No model request is involved.
// Exits non-zero when the swap failed, so the old session's channel (if it still runs) delivers normally again.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatReply, isLinear, replyTag } from '../core/lib.mjs'
import { ghComment } from '../core/github.mjs'
import * as linear from '../core/linear.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const r = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const short = id => id?.slice(0, 8)

const args = ['--pane', r.pane, '--session', r.from, '--no-compact', ...(r.then ? ['--then', r.then] : [])]
if (r.session && r.session !== 'default') args.push('--name', r.session)
const run = spawnSync(path.join(HERE, 'restart-agent.sh'), args, { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: '' } })
process.stderr.write(run.stderr ?? '')
let result = null
try { result = JSON.parse((run.stdout ?? '').trim().split('\n').at(-1)) } catch {}
const ok = run.status === 0 && result?.session
console.log(JSON.stringify({ ok, result }))

const tag = replyTag({ name: r.session, agent: { agent: 'cc', id: ok ? result.session : r.from } })
const summary = ok
  ? `no-compact: reset cc:${short(r.from)} → cc:${short(result.session)} in ${result.seconds}s${r.then ? '; the successor answers next' : ''}`
  : `no-compact failed for cc:${short(r.from)}`
const body = ok
  ? [
      `Session \`${r.session}\` now runs as \`${result.session}\`, a fork of \`${r.from}\` that keeps no turn. It starts from the system prompt, the tools and a note with the old log's path, how to read it back, and the last exchange verbatim. No summary was generated and no request went to the old context.`,
      '',
      `Subscriptions, cursors and open /bot requests were handed over. Rollback: \`--resume ${r.from}\` (the old log is untouched).`,
      r.then ? '\nThe text after the command was typed into the new session as its first prompt.' : '',
    ].join('\n')
  : `The swap failed. If it stopped before the old session exited (the usual case: not idle, or a dialog), that session keeps listening with its full context. Last lines of the swap log:\n\n\`\`\`\n${(run.stderr ?? run.error?.message ?? '').trim().split('\n').slice(-12).join('\n')}\n\`\`\``
try {
  if (isLinear(r.repo)) await linear.comment(r.repo, r.issue, formatReply({ summary, body, tag, format: 'linear' }), { parentId: r.reply_to })
  else await ghComment(r.repo, r.issue, formatReply({ summary, body, tag }))
} catch (e) { console.error(`no-compact: reply failed: ${e.message}`) }
process.exit(ok ? 0 : 1)
