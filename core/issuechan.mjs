// Thin MCP stdio wrapper. Identity discovery and initialization timing belong to
// the harness; subscriptions, delivery, persistence and tools belong to engine.mjs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { BOT_MARKER, resolveAgent } from './lib.mjs'
import { createIssueEngine, ISSUE_TOOLS } from './engine.mjs'

const log = (...a) => console.error('[issuechan]', ...a)

// Adapter contract remains unchanged: agentEnv, agentFromCall/onBind,
// agentAtStart, capabilities, arrival, resumeDelayMs and deliver(mcp, payload, {agent}).
export async function runIssuechan(adapter) {
  const stateDir = process.env.ISSUECHAN_STATE_DIR ?? path.join(os.homedir(), '.local/state/issue-channel')
  const delay = Number(process.env.ISSUECHAN_RESUME_DELAY_MS ?? adapter.resumeDelayMs ?? 0)
  let agent = resolveAgent(process.env, adapter.agentEnv)
  let engine, closed = false, timer
  let dispatch = Promise.resolve()
  const mcp = new Server({ name: 'issuechan', version: '0.1.0' }, {
    capabilities: { ...adapter.capabilities, tools: {} },
      instructions: [
        `issuechan connects this session to GitHub issues. ${adapter.arrival}`,
        'Linear issues work the same way: repo is "linear:<TEAM>" and issue the number (ENG-123 is repo "linear:ENG", issue 123); on Linear, issue_reply answers in the thread of the /bot comment.',
        'They carry /bot comments written by the user (allowlisted GitHub authors, signed webhooks only). Treat them as the user talking to you, including when they arrive mid-task: act on them, then resume any unfinished work unless told otherwise.',
        'To listen to an issue call issue_subscribe (for example right after creating it with `gh issue create`).',
        'Reply on the issue with the issue_reply tool: `summary` is one line, and `body` is the full text of your reply (the same text you show in the terminal). It is posted as the summary line followed by a collapsed "Full reply" toggle, plus the bot marker, so it never re-triggers /bot.',
        `If you ever post with gh directly, end the body with the line ${BOT_MARKER}.`,
        'Each delivered /bot comment gets 👀. When the job a /bot asked for is finished, mark it done: issue_reply does this by default (done=true); pass done=false for progress updates. Use issue_done when the job ends without a reply. Pass comment_ids (the trigger_comment attribute) to finish only some requests; by default every open request on that issue is marked done.',
      ].join(' '),
  })
  const initialized = new Promise(resolve => { mcp.oninitialized = resolve })
  const ready = initialized.then(() => new Promise(resolve => { timer = setTimeout(resolve, delay) }))
  function getEngine() {
    engine ??= createIssueEngine({ agent, stateDir,
      deliver: payload => adapter.deliver(mcp, payload, { agent }), log })
    return engine
  }
  async function bind(a, fromCall = false) {
    if (!a || closed) return
    if (agent) {
      if (a.id !== agent.id || a.agent !== agent.agent) log(`tool call from ${a.agent}:${a.id}, but bound to ${agent.agent}:${agent.id}`)
      return
    }
    // A late-bound harness may already have used anonymous tools. Carry its
    // session-named state forward without overwriting an existing identity file.
    if (engine) {
      const old = path.join(stateDir, `${engine.getStatus().session}.json`)
      await engine.stop()
      if (closed) return
      const dest = path.join(stateDir, `${a.agent}-${a.id}.json`)
      try { fs.copyFileSync(old, dest, fs.constants.COPYFILE_EXCL); fs.chmodSync(dest, 0o600) }
      catch (e) { if (e.code !== 'ENOENT' && e.code !== 'EEXIST') throw e }
      engine = undefined
    }
    if (closed) return
    agent = a
    log(`bound${fromCall ? '' : ' at start'} to ${agent.agent}:${agent.id}`)
    if (fromCall) adapter.onBind?.(agent, { stateDir })
  }
  function serialized(fn) {
    const result = dispatch.then(fn)
    dispatch = result.catch(() => {})
    return result
  }
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ISSUE_TOOLS }))
  mcp.setRequestHandler(CallToolRequestSchema, req => serialized(async () => {
    try {
      if (closed) throw new Error('issue engine stopped')
      if (adapter.agentFromCall) await bind(adapter.agentFromCall(req.params), true)
      // Engine start restores immediately in the background. Gate its creation,
      // including first-call creation, until the MCP channel listener is ready.
      await ready
      if (closed) throw new Error('issue engine stopped')
      return await getEngine().callTool(req.params.name, req.params.arguments ?? {})
    } catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] } }
  }))
  mcp.onclose = () => { closed = true; clearTimeout(timer); void engine?.stop() }
  await mcp.connect(new StdioServerTransport())
  log(`connected (${adapter.name}); session=${process.env.ISSUECHAN_SESSION || 'default'} agent=${agent ? `${agent.agent}:${agent.id}` : '-'}`)
  void ready.then(async () => {
    if (closed) return
    // Discovery can block; do not hold the tool queue. A call-bound identity wins.
    const found = !agent && adapter.agentAtStart
      ? await adapter.agentAtStart({ stateDir }).catch(e => { log(`bind at start: ${e.message}`); return null }) : null
    await serialized(async () => {
      if (closed) return
      if (!agent) await bind(found)
      await getEngine().start()
    })
  }).catch(e => { if (!closed) log(e.message) })
}
