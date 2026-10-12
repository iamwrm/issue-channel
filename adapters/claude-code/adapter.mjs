// Claude Code adapter: deliveries are Claude Code channel notifications.
// Launch: claude --dangerously-skip-permissions --dangerously-load-development-channels server:issuechan
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')

export default {
  name: 'claude-code',
  // Claude Code passes its session id to MCP servers when it spawns them (`--resume` on the command line or /mcp
  // reconnect). A /resume inside the TUI does not respawn them, so the id goes stale: see README.md.
  agentEnv: [['cc', 'CLAUDE_CODE_SESSION_ID']],
  capabilities: { experimental: { 'claude/channel': {} } },
  arrival: 'Messages arrive as <channel source="issuechan" repo="..." issue="..." ...>.',
  // Claude Code registers its channel listener a moment after the MCP handshake, and drops
  // notifications sent before that.
  resumeDelayMs: 3000,
  deliver: (mcp, { content, meta }) => mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } }),
  // `/bot !no-compact`: swap this session for a reset fork in its herdr pane (spawn/no-compact.mjs, detached, since
  // the swap ends this process). It must not need the model, so it fails here, before anything changes, when it
  // can't run.
  noCompact({ repo, issue, session, agent, then, comment_id, reply_to, onFailed }, { log } = {}) {
    const pane = process.env.HERDR_PANE_ID
    if (!pane) throw new Error('the session is not in a herdr pane (HERDR_PANE_ID is not set)')
    if (agent?.agent !== 'cc') throw new Error('no Claude Code session id')
    const dir = path.join(os.tmpdir(), `no-compact-${agent.id}`)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const req = path.join(dir, 'request.json')
    fs.writeFileSync(req, JSON.stringify({ repo, issue, session, pane, from: agent.id, then, comment_id, reply_to }), { mode: 0o600 })
    const out = fs.openSync(path.join(dir, 'swap.log'), 'a')
    const child = spawn(process.execPath, [path.join(ROOT, 'spawn/no-compact.mjs'), req], { detached: true, stdio: ['ignore', out, out] })
    child.on('exit', code => { if (code) { log?.(`no-compact swap exited ${code}; see ${dir}/swap.log`); onFailed?.() } })
    child.unref()
  },
}
