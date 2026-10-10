// Codex adapter: deliveries become user input on the agent's thread through the Codex app-server
// (turn/start, which also steers a busy turn). Codex runs one MCP server process per thread and passes
// the thread id only with tool calls (`_meta.threadId`), so the first tool call binds this process;
// after an app-server restart, agentAtStart can bind it earlier (see below).
// Launch: see adapters/codex/README.md.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AppServer } from './appserver.mjs'

const ID_RE = /^[A-Za-z0-9-]+$/
const sleep = ms => new Promise(r => setTimeout(r, ms))

// The managed app-server daemon (`codex app-server daemon start|bootstrap`) that the Codex GUI and
// ChatGPT's Remote SSH attach to. Codex hides CODEX_HOME from MCP servers, so only the default home works.
export const DAEMON_SOCK = path.join(os.homedir(), '.codex/app-server-control/app-server-control.sock')

// ISSUECHAN_CODEX_RETRY_MS: comma-separated waits between delivery attempts ("" = no retries;
// the core's poll loop then redelivers with its own backoff).
const envRetry = process.env.ISSUECHAN_CODEX_RETRY_MS
const RETRY_MS = envRetry === undefined ? [1000, 2000, 5000, 10000, 20000] : envRetry.split(',').filter(Boolean).map(Number)
// Waits between startup binding attempts (ISSUECHAN_CODEX_BIND_MS, same format).
const envBind = process.env.ISSUECHAN_CODEX_BIND_MS
const BIND_MS = envBind === undefined ? [500, 1000, 2000] : envBind.split(',').filter(Boolean).map(Number)

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

// Claims: <stateDir>/codex-claims/<thread id> holds the pid of the issuechan process bound to that thread.
function claims(stateDir) {
  const dir = path.join(stateDir, 'codex-claims')
  const file = id => path.join(dir, id)
  const owner = id => { try { return Number(fs.readFileSync(file(id), 'utf8')) } catch { return 0 } }
  return {
    takenByOther: id => { const pid = owner(id); return pid > 0 && pid !== process.pid && alive(pid) },
    claim: id => {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file(id) + `.${process.pid}`, String(process.pid))
      fs.renameSync(file(id) + `.${process.pid}`, file(id))
    },
  }
}

const hasSavedSubs = stateDir => {
  try {
    return fs.readdirSync(stateDir).filter(f => /^codex-.*\.json$/.test(f)).some(f => {
      try { return Object.keys(JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8')).subs ?? {}).length > 0 } catch { return false }
    })
  } catch { return false }
}

const realpath = p => { try { return fs.realpathSync(p) } catch { return p } }

export function createCodexAdapter({ sock = process.env.ISSUECHAN_CODEX_SOCK || DAEMON_SOCK, retryMs = RETRY_MS, bindMs = BIND_MS,
  cwd = process.cwd(), log = (...a) => console.error('[issuechan]', ...a) } = {}) {
  const server = sock ? new AppServer(sock, { log }) : null
  return {
    name: 'codex',
    agentEnv: [],
    agentFromCall: params => {
      const id = params?._meta?.threadId
      return typeof id === 'string' && ID_RE.test(id) ? { agent: 'codex', id } : null
    },
    // A tool call proved which thread this process serves: claim it, so no restarted peer guesses it.
    onBind(agent, { stateDir }) {
      try { claims(stateDir).claim(agent.id) } catch (e) { log(`claim ${agent.id}: ${e.message}`) }
    },
    // After an app-server restart the agent's subscriptions should resume before its next tool call.
    // Codex spawns a thread's MCP process while loading that thread, so the thread is already in
    // thread/loaded/list. Bind only when that is unambiguous: exactly one loaded thread in this cwd
    // that no live issuechan process has claimed. Otherwise wait for the first tool call, as before.
    async agentAtStart({ stateDir }) {
      if (!server || !hasSavedSubs(stateDir)) return null
      const c = claims(stateDir)
      const here = realpath(cwd)
      let why = ''
      for (let i = 0; ; i++) {
        try {
          const open = []
          for (const id of await server.loadedThreads()) {
            if (!ID_RE.test(id) || c.takenByOther(id)) continue
            if (realpath(await server.threadCwd(id)) === here) open.push(id)
          }
          if (open.length === 1) {
            c.claim(open[0])
            return { agent: 'codex', id: open[0] }
          }
          why = open.length ? `${open.length} unclaimed threads in ${here}` : `no unclaimed thread in ${here}`
        } catch (e) {
          why = e.message
          server.reset(e)
        }
        if (i >= bindMs.length) break
        await sleep(bindMs[i])
      }
      log(`not bound at start (${why}); waiting for the first tool call`)
      return null
    },
    capabilities: {},
    arrival: 'Each /bot arrives as a user message that starts with "GitHub issue <owner/repo>#<n> ...: /bot from @<author>".',
    resumeDelayMs: 0,
    async deliver(mcp, { content }, { agent }) {
      if (!server) throw new Error('no Codex app-server socket')
      if (!agent) throw new Error('not bound to a Codex thread yet (no tool call seen)')
      // Retry briefly here; after that the core's poll loop redelivers with its own backoff.
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
