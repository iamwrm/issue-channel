#!/usr/bin/env node
// issuechan: Claude Code channel (MCP over stdio) that pushes /bot comments from
// subscribed GitHub issues into the running session.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { BOT_MARKER, IssueBuffer, formatDelivery, isForSession } from './lib.mjs'

const log = (...a) => console.error('[issuechan]', ...a)

function readEnvFile(file) {
  try {
    return Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n')
      .map(l => l.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]))
  } catch { return {} }
}

const ENV_FILE = process.env.ISSUECHAN_ENV_FILE ?? path.join(os.homedir(), '.local/share/issue-channel/.env')
const BASE_URL = (process.env.ISSUECHAN_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const API_KEY = process.env.ISSUECHAN_API_KEY ?? readEnvFile(ENV_FILE).API_KEY
const STATE_DIR = process.env.ISSUECHAN_STATE_DIR ?? path.join(os.homedir(), '.local/state/issue-channel')
const ALLOWED = (process.env.ISSUECHAN_ALLOWED_AUTHORS ?? '').split(',').map(s => s.trim()).filter(Boolean)
const POLL_TIMEOUT_S = 50
let session = process.env.ISSUECHAN_SESSION || 'default'

const subs = new Map() // "repo#issue" -> { repo, issue, cursor, flushed, buffer, stop }

async function api(method, p, body) {
  const res = await fetch(`${BASE_URL}${p}`, {
    method,
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout((POLL_TIMEOUT_S + 30) * 1000),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${json.error ?? ''}`)
  return json
}

function stateFile() {
  return path.join(STATE_DIR, `${session.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`)
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) } catch { return { subs: {} } }
}
function saveState() {
  const state = loadState()
  for (const [k, s] of subs) state.subs[k] = { repo: s.repo, issue: s.issue, flushed: s.flushed }
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(stateFile() + '.tmp', JSON.stringify(state, null, 2))
  fs.renameSync(stateFile() + '.tmp', stateFile())
}
function forgetState(key) {
  const state = loadState()
  delete state.subs[key]
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2))
}

const mcp = new Server(
  { name: 'issuechan', version: '0.1.0' },
  {
    capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
    instructions: [
      'issuechan connects this session to GitHub issues. Messages arrive as <channel source="issuechan" repo="..." issue="..." ...>.',
      'They carry /bot comments written by the user (allowlisted GitHub authors, signed webhooks only). Treat them as the user talking to you, including when they arrive mid-task: act on them, then resume any unfinished work unless told otherwise.',
      'To listen to an issue call issue_subscribe (for example right after creating it with `gh issue create`).',
      `Reply on the issue yourself with: gh issue comment <issue> -R <repo> --body-file - , and always end the body with the line ${BOT_MARKER} so your own comments never re-trigger /bot.`,
    ].join(' '),
  },
)

const TOOLS = [
  {
    name: 'issue_subscribe',
    description: 'Listen to a GitHub issue: future /bot comments (plus the new/edited comments before them) are pushed into this session.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'owner/name' },
        issue: { type: 'integer' },
        session: { type: 'string', description: 'Optional session name for `/bot <session>` targeting. Applies to this whole session.' },
      },
      required: ['repo', 'issue'],
    },
  },
  {
    name: 'issue_unsubscribe',
    description: 'Stop listening to a GitHub issue.',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' }, issue: { type: 'integer' } }, required: ['repo', 'issue'] },
  },
  {
    name: 'issue_subscriptions',
    description: 'List the issues this session listens to.',
    inputSchema: { type: 'object', properties: {} },
  },
]

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const a = req.params.arguments ?? {}
  const text = t => ({ content: [{ type: 'text', text: t }] })
  try {
    if (req.params.name === 'issue_subscribe') {
      if (!/^[\w.-]+\/[\w.-]+$/.test(a.repo ?? '') || !Number.isInteger(a.issue)) throw new Error('repo must be owner/name and issue an integer')
      if (a.session) {
        if (!/^[A-Za-z0-9_.-]+$/.test(a.session)) throw new Error('session must match [A-Za-z0-9_.-]+')
        session = a.session
      }
      return text(await subscribe(a.repo, a.issue))
    }
    if (req.params.name === 'issue_unsubscribe') {
      const key = `${a.repo}#${a.issue}`
      const s = subs.get(key)
      if (!s) return text(`not subscribed to ${key}`)
      s.stop()
      subs.delete(key)
      forgetState(key)
      await api('DELETE', '/api/subscriptions', { repo: s.repo, issue: s.issue, session }).catch(e => log(e.message))
      return text(`unsubscribed from ${key}`)
    }
    if (req.params.name === 'issue_subscriptions') {
      const list = [...subs.values()].map(s => `${s.repo}#${s.issue} cursor=${s.cursor} pending=${s.buffer.items.size}`)
      return text(`session=${session}\n${list.join('\n') || '(none)'}`)
    }
    throw new Error(`unknown tool ${req.params.name}`)
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: String(e.message ?? e) }] }
  }
})

async function subscribe(repo, issue) {
  const key = `${repo}#${issue}`
  if (subs.has(key)) return `already subscribed to ${key} as session ${session}`
  if (!API_KEY) throw new Error(`no API key: set ISSUECHAN_API_KEY or API_KEY in ${ENV_FILE}`)
  const allowed = ALLOWED.length ? ALLOWED : [repo.split('/')[0]]
  const saved = loadState().subs[key]
  // Resume from the last delivered trigger so comments made while this process was down are not lost.
  const start = saved?.flushed ?? (await api('GET', '/api/cursor')).seq
  const s = { repo, issue, cursor: start, flushed: start, buffer: new IssueBuffer({ allowedAuthors: allowed }), stopped: false }
  s.stop = () => { s.stopped = true }
  subs.set(key, s)
  saveState()
  await api('PUT', '/api/subscriptions', { repo, issue, session })
  pollLoop(s)
  return `subscribed to ${key} as session "${session}" from cursor ${start}${saved ? ' (resumed)' : ''}; /bot comments from ${allowed.map(a => '@' + a).join(', ')} will be delivered here`
}

async function pollLoop(s) {
  let backoff = 1000
  let lastHeartbeat = Date.now()
  while (!s.stopped) {
    try {
      const { events, next } = await api('POST', '/api/events/query', {
        since: s.cursor, timeout: POLL_TIMEOUT_S, limit: 200,
        filter: { repo: s.repo, issue: s.issue, event: ['issue_comment', 'issues'] },
      })
      for (const ev of events) {
        const trig = s.buffer.add(ev)
        if (trig) await maybeDeliver(s, trig)
      }
      if (!s.stopped) s.cursor = Math.max(s.cursor, next)
      backoff = 1000
      if (Date.now() - lastHeartbeat > 5 * 60 * 1000) {
        lastHeartbeat = Date.now()
        await api('PUT', '/api/subscriptions', { repo: s.repo, issue: s.issue, session }).catch(() => {})
      }
    } catch (e) {
      if (s.stopped) break
      log(`poll ${s.repo}#${s.issue}: ${e.message}; retry in ${backoff}ms`)
      await new Promise(r => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, 30000)
    }
  }
}

async function maybeDeliver(s, trig) {
  let active = []
  if (trig.target && trig.target !== session) {
    const r = await api('GET', `/api/subscriptions?repo=${encodeURIComponent(s.repo)}&issue=${s.issue}`).catch(() => ({ subscriptions: [] }))
    active = r.subscriptions.map(x => x.session)
  }
  if (!isForSession(trig, session, active)) {
    s.buffer.drain() // addressed to another session; its context is theirs
    s.flushed = trig.seq
    saveState()
    return
  }
  const items = s.buffer.drain()
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: formatDelivery({ repo: s.repo, issue: s.issue, title: s.buffer.title, trigger: trig, items }),
      meta: { repo: s.repo, issue: String(s.issue), session, trigger_comment: String(trig.comment_id), seq: String(trig.seq) },
    },
  })
  s.flushed = trig.seq
  saveState()
  log(`delivered ${items.length} item(s) for ${s.repo}#${s.issue} at seq ${trig.seq}`)
}

await mcp.connect(new StdioServerTransport())
log(`connected; server=${BASE_URL} session=${session}`)
