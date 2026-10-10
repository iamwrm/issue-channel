// Shared harness for adapter integration tests: the real issue-channel server (in-memory db),
// signed webhooks, and an MCP client that starts an adapter entry over stdio.
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { openDb, createApp } from '../server/server.mjs'

export const SECRET = 's'.repeat(40)
export const KEY = 'k'.repeat(40)
export const REPO = 'o/r'
export const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function until(fn, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (fn()) return true
  return false
}

export async function startServer() {
  const server = http.createServer(createApp({ db: openDb(':memory:'), webhookSecret: SECRET, apiKey: KEY, log: () => {} }))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issuechan-test-'))
  let nextComment = 1000, nextDelivery = 0

  async function comment(issue, body) {
    const id = ++nextComment
    const now = new Date().toISOString()
    const raw = JSON.stringify({
      action: 'created', repository: { full_name: REPO }, issue: { number: issue, title: 'T' },
      comment: { id, body, user: { login: 'me' }, created_at: now, updated_at: now }, sender: { login: 'me' },
    })
    const res = await fetch(`${base}/webhook/github`, {
      method: 'POST', body: raw,
      headers: {
        'x-github-event': 'issue_comment', 'x-github-delivery': `d-${++nextDelivery}`, 'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex'),
      },
    })
    assert.ok(res.ok, `webhook ${res.status}`)
    return id
  }

  async function api(method, p) {
    const res = await fetch(`${base}${p}`, { method, headers: { authorization: `Bearer ${KEY}` } })
    return res.json()
  }
  const registered = async issue =>
    (await api('GET', `/api/subscriptions?repo=${encodeURIComponent(REPO)}&issue=${issue}`)).subscriptions.map(s => s.session).sort()

  // Start an adapter entry as an MCP server; `env` adds harness-specific variables, `cwd` sets its directory.
  // Collects Claude Code channel notifications in `got` (other harnesses deliver out of band).
  async function start(entry, env = {}, { cwd } = {}) {
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
    const got = []
    client.fallbackNotificationHandler = async n => {
      if (n.method === 'notifications/claude/channel') got.push({ at: Date.now(), ...n.params })
    }
    const transport = new StdioClientTransport({
      command: process.execPath, args: [entry], stderr: 'ignore', cwd,
      env: {
        PATH: process.env.PATH, ISSUECHAN_URL: base, ISSUECHAN_API_KEY: KEY, ISSUECHAN_STATE_DIR: stateDir,
        ISSUECHAN_ALLOWED_AUTHORS: 'me', ISSUECHAN_REACTION: '', ISSUECHAN_DONE_REACTION: '', ...env,
      },
    })
    const t0 = Date.now()
    await client.connect(transport)
    const call = async (name, args = {}, _meta) => (await client.callTool({ name, arguments: args, ...(_meta && { _meta }) })).content[0].text
    return { client, got, call, t0, close: () => client.close() }
  }

  const close = () => { server.close(); fs.rmSync(stateDir, { recursive: true, force: true }) }
  return { base, stateDir, comment, api, registered, start, close }
}
