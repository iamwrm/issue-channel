import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { until } from '../testkit.mjs'

const bridge = fileURLToPath(new URL('./desktop-bridge.mjs', import.meta.url))
const proxy = fileURLToPath(new URL('./desktop-proxy.sh', import.meta.url))
const launcher = fileURLToPath(new URL('./Start ChatGPT with Issue Channel.command', import.meta.url))

test('desktop bridge forwards split JSONL input, daemon responses, and approvals without answering them', { timeout: 10000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-desktop-'))
  const socket = path.join(dir, 'socket'), link = path.join(dir, 'link')
  const server = http.createServer(), wss = new WebSocketServer({ server })
  await new Promise(resolve => server.listen(socket, resolve))
  fs.symlinkSync(socket, link)
  let child
  try {
    const connected = once(wss, 'connection')
    child = spawn(process.execPath, [bridge], { env: { ...process.env, ISSUECHAN_CODEX_SOCK: link } })
    const [ws] = await connected
    const received = []
    ws.on('message', data => received.push(JSON.parse(String(data))))
    const output = readline.createInterface({ input: child.stdout })
    child.stdin.write('{"id":1,"method":"initialize",')
    child.stdin.write('"params":{}}\n\n{"method":"initialized"}\n')
    await until(() => received.length === 2)
    const response = once(output, 'line')
    ws.send(JSON.stringify({ id: 1, result: { userAgent: 'test' } }))
    assert.deepEqual(JSON.parse((await response)[0]), { id: 1, result: { userAgent: 'test' } })
    const approval = once(output, 'line')
    ws.send(JSON.stringify({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { command: ['true'] } }))
    assert.equal(JSON.parse((await approval)[0]).id, 'approval-1')
    // A round trip after the approval proves the bridge hasn't answered it in between.
    const roundTrip = once(ws, 'message')
    child.stdin.write('{"id":2,"method":"thread/loaded/list","params":{}}\n')
    await roundTrip
    assert.deepEqual(received.map(x => x.method), ['initialize', 'initialized', 'thread/loaded/list'])
    assert.ok(received.every(x => x.id !== 'approval-1'))
    const approved = once(ws, 'message')
    child.stdin.write('{"id":"approval-1","result":{"decision":"accept"}}\n')
    assert.deepEqual(JSON.parse(String((await approved)[0])), { id: 'approval-1', result: { decision: 'accept' } })
    const exited = once(child, 'exit')
    child.stdin.end()
    assert.equal((await exited)[0], 0)
    output.close()
  } finally {
    child?.kill()
    for (const ws of wss.clients) ws.terminate()
    await new Promise(resolve => wss.close(resolve))
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('desktop bridge reports a missing socket and exits instead of starting a private server', () => {
  assert.throws(() => execFileSync(process.execPath, [bridge], { env: { ...process.env, ISSUECHAN_CODEX_SOCK: '/nonexistent/issuechan.sock' }, stdio: 'pipe' }), error => {
    assert.equal(error.status, 1)
    assert.match(error.stderr.toString(), /daemon socket unavailable/)
    return true
  })
})

test('desktop proxy preserves normal CLI and daemon-management arguments', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop cli # '))
  const real = path.join(dir, 'fake codex')
  try {
    fs.writeFileSync(real, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 })
    const env = { ...process.env, ISSUECHAN_DESKTOP_CODEX_CLI: real }
    for (const args of [['--version'], ['-c', 'key=a b', 'app-server', 'daemon', 'start'], ['app-server', 'generate-json-schema', '--out', 'a b']]) {
      assert.deepEqual(execFileSync('sh', [proxy, ...args], { env, encoding: 'utf8' }).trimEnd().split('\n'), args)
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('launcher starts daemon then passes the selected proxy and Node paths to the desktop app', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop app # '))
  const cli = path.join(dir, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
  const app = path.join(dir, 'Contents/MacOS/ChatGPT')
  try {
    fs.mkdirSync(path.dirname(cli), { recursive: true })
    fs.mkdirSync(path.dirname(app), { recursive: true })
    fs.writeFileSync(cli, '#!/bin/sh\nprintf "%s\\n" "$*"\n', { mode: 0o700 })
    fs.writeFileSync(app, '#!/bin/sh\nprintf "%s\\n" "$CODEX_CLI_PATH" "$ISSUECHAN_DESKTOP_NODE" "$ISSUECHAN_DESKTOP_CODEX_CLI" "$@"\n', { mode: 0o700 })
    const lines = execFileSync('sh', [launcher, 'argument with spaces'], { encoding: 'utf8', env: { ...process.env, ISSUECHAN_CHATGPT_APP: dir, ISSUECHAN_NODE_BIN: process.execPath } }).trimEnd().split('\n')
    assert.deepEqual(lines, ['app-server daemon start', proxy, process.execPath, cli, 'argument with spaces'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
