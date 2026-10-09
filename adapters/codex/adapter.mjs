// Codex adapter: deliveries become user input on the agent's thread through the Codex app-server
// (turn/start, which also steers a busy turn). Codex runs one MCP server process per thread and passes
// the thread id only with tool calls (`_meta.threadId`), so the first tool call binds this process.
// Launch: see adapters/codex/README.md.
import { AppServer } from './appserver.mjs'

const ID_RE = /^[A-Za-z0-9-]+$/
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ISSUECHAN_CODEX_RETRY_MS: comma-separated waits between delivery attempts ("" = no retries;
// the core's poll loop then redelivers with its own backoff).
const envRetry = process.env.ISSUECHAN_CODEX_RETRY_MS
const RETRY_MS = envRetry === undefined ? [1000, 2000, 5000, 10000, 20000] : envRetry.split(',').filter(Boolean).map(Number)

export function createCodexAdapter({ sock = process.env.ISSUECHAN_CODEX_SOCK, retryMs = RETRY_MS, log = (...a) => console.error('[issuechan]', ...a) } = {}) {
  const server = sock ? new AppServer(sock, { log }) : null
  return {
    name: 'codex',
    agentEnv: [],
    agentFromCall: params => {
      const id = params?._meta?.threadId
      return typeof id === 'string' && ID_RE.test(id) ? { agent: 'codex', id } : null
    },
    capabilities: {},
    arrival: 'Each /bot arrives as a user message that starts with "GitHub issue <owner/repo>#<n> ...: /bot from @<author>".',
    resumeDelayMs: 0,
    async deliver(mcp, { content }, { agent }) {
      if (!server) throw new Error('ISSUECHAN_CODEX_SOCK is not set: cannot reach the Codex app-server')
      if (!agent) throw new Error('not bound to a Codex thread yet (no tool call seen)')
      // Retry for a while: the core has already drained this delivery, so a failure here drops it.
      for (let i = 0; ; i++) {
        try {
          const turnId = await server.send(agent.id, content)
          log(`delivered to codex thread ${agent.id} (turn ${turnId})`)
          return
        } catch (e) {
          if (i >= retryMs.length) throw e
          log(`deliver to codex thread ${agent.id}: ${e.message}; retry in ${retryMs[i]}ms`)
          server.reset(e)
          await sleep(retryMs[i])
        }
      }
    },
  }
}

export default createCodexAdapter()
