// Claude Code adapter: deliveries are Claude Code channel notifications.
// Launch: claude --dangerously-skip-permissions --dangerously-load-development-channels server:issuechan

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
}
