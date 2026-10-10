#!/usr/bin/env node
// ChatGPT's embedded client speaks JSONL; the managed daemon uses WebSocket frames.
// Forward messages unchanged, including approvals. This is a transport, not a UI.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import WebSocket from 'ws'

let socket
try {
  socket = fs.realpathSync(process.env.ISSUECHAN_CODEX_SOCK ?? path.join(os.homedir(), '.codex/app-server-control/app-server-control.sock'))
} catch {
  console.error('issuechan: daemon socket unavailable; start the managed daemon before launching ChatGPT.')
  process.exit(1)
}

const ws = new WebSocket(`ws+unix://${socket}:/`, { maxPayload: 128 * 1024 * 1024, handshakeTimeout: 10000 })
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const queue = []
let failed = false
lines.on('line', line => {
  if (!line.trim()) return
  if (ws.readyState === WebSocket.OPEN) ws.send(line)
  else if (ws.readyState === WebSocket.CONNECTING) queue.push(line)
})
ws.on('open', () => { for (const line of queue.splice(0)) ws.send(line) })
ws.on('message', data => { process.stdout.write(String(data) + '\n') })
ws.on('error', () => {
  failed = true
  console.error('issuechan: desktop bridge could not connect to the local daemon; restart it and relaunch ChatGPT.')
})
ws.on('close', () => process.exit(failed ? 1 : 0))
lines.on('close', () => {
  if (ws.readyState === WebSocket.OPEN) ws.close()
  else if (ws.readyState === WebSocket.CONNECTING) ws.once('open', () => ws.close())
})
process.stdout.on('error', () => { ws.terminate(); process.exit(1) })
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { ws.terminate(); process.exit(0) })
