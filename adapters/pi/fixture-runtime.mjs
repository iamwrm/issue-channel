// Real Pi subprocess harness shared by the RPC and tmux tests.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startServer, KEY, sleep } from '../testkit.mjs'

export const directory = path.dirname(fileURLToPath(import.meta.url))
const localPi = path.resolve(directory, '../../node_modules/.bin/pi')
export const piCommand = process.env.ISSUECHAN_TEST_PI ?? (fs.existsSync(localPi) ? localPi : 'pi')
export const hasPi = spawnSync(piCommand, ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0
export const messageText = m => typeof m?.content === 'string' ? m.content
  : (m?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')
export const deliveryHeader = /\[issue-channel delivery=([a-f0-9]{64})\]/
export async function waitFor(fn, description, timeout = 8000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const result = await fn()
    if (result) return result
    await sleep(25)
  }
  throw new Error(`Timed out (${timeout}ms): ${description}`)
}
export function jsonLines(file) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) }
  catch (e) { if (e.code === 'ENOENT') return []; throw e }
}
export async function fixture(t, { faultProxy = false } = {}) {
  const server = await startServer()
  // Optional transparent local proxy lets the terminal test observe real reconnect transitions.
  let proxy, base = server.base
  const requests = new Set(), faults = { queries: false }
  if (faultProxy) {
    proxy = http.createServer(async (req, res) => {
      if (faults.queries && req.url === '/api/events/query') {
        req.resume(); res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"test reconnect outage"}'); return
      }
      const controller = new AbortController(); requests.add(controller)
      res.on('close', () => { if (!res.writableEnded) controller.abort() })
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk)
        const response = await fetch(server.base + req.url, { method: req.method, headers: req.headers,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}), signal: controller.signal })
        const body = Buffer.from(await response.arrayBuffer())
        res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' }); res.end(body)
      } catch (error) { if (!res.destroyed) { res.writeHead(502); res.end(JSON.stringify({ error: String(error) })) } }
      finally { requests.delete(controller) }
    })
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${proxy.address().port}`
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issuechan-pi-'))
  for (const name of ['home', 'config', 'sessions', 'work', 'control', 'bin']) fs.mkdirSync(path.join(root, name))
  // Fail loudly if production accidentally invokes an authenticated CLI.
  for (const name of ['gh', 'linear']) fs.writeFileSync(path.join(root, 'bin', name), '#!/bin/sh\necho "Unexpected live CLI invocation" >&2\nexit 97\n', { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'bin', 'gh'), `#!/bin/sh\nexec '${process.execPath}' '${path.join(directory, 'fixture-gh.mjs')}' "$@"\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'config', 'auth.json'), '{}')
  fs.writeFileSync(path.join(root, 'config', 'settings.json'), JSON.stringify({ quietStartup: true, enableAutoCompaction: false, enableAutoRetry: false }))
  const env = {
    PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, HOME: path.join(root, 'home'),
    LANG: 'C.UTF-8', TERM: 'xterm-256color', PI_CODING_AGENT_DIR: path.join(root, 'config'),
    PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    ISSUECHAN_URL: base, ISSUECHAN_API_KEY: KEY, ISSUECHAN_STATE_DIR: server.stateDir,
    ISSUECHAN_ALLOWED_AUTHORS: 'me', ISSUECHAN_LINEAR_ALLOWED: 'me@example.com',
    ISSUECHAN_REACTION: '', ISSUECHAN_DONE_REACTION: '',
    ISSUECHAN_LINEAR_REACTION: '', ISSUECHAN_LINEAR_DONE_REACTION: '', ISSUECHAN_LINEAR_DONE: 'reaction',
    ISSUECHAN_TEST_CONTROL: path.join(root, 'control'), ISSUECHAN_TEST_SNAPSHOTS: path.join(root, 'snapshots.jsonl'),
    ISSUECHAN_TEST_GH_LOG: path.join(root, 'gh.jsonl'),
  }
  const processes = new Set(), cleanups = []
  const commonArgs = ['--no-extensions', '-e', path.join(directory, 'fixture-provider.ts'), '-e', path.join(directory, 'index.ts'),
    '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-mcp', '--offline',
    '--provider', 'issuechan-test', '--model', 'deterministic', '--session-dir', path.join(root, 'sessions')]
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
    for (const p of processes) await p.close()
    for (const controller of requests) controller.abort()
    if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)) }
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    server, root, env, commonArgs, faults, onCleanup: fn => cleanups.push(fn),
    snapshots: () => jsonLines(env.ISSUECHAN_TEST_SNAPSHOTS),
    async rpc(extra = []) {
      const child = spawn(piCommand, [...commonArgs, '--mode', 'rpc', ...extra], { cwd: path.join(root, 'work'), env, stdio: ['pipe', 'pipe', 'pipe'] })
      const events = [], pending = new Map()
      let stderr = '', buffer = '', serial = 0, exited = false
      child.stderr.on('data', chunk => { stderr += chunk })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        buffer += chunk
        let pos
        while ((pos = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, pos).replace(/\r$/, ''); buffer = buffer.slice(pos + 1)
          if (!line) continue
          let record
          try { record = JSON.parse(line) } catch { stderr += `\nNon-JSON stdout: ${line}`; continue }
          events.push(record)
          if (record.type === 'response' && pending.has(record.id)) {
            pending.get(record.id)(record); pending.delete(record.id)
          }
        }
      })
      child.on('error', e => { stderr += String(e); exited = true })
      child.on('exit', () => { exited = true })
      const rpc = {
        child, events, diagnostics: () => stderr,
        async send(type, fields = {}) {
          assert.ok(!exited, `Pi exited: ${stderr}`)
          const id = `request-${++serial}`
          let response
          pending.set(id, r => { response = r })
          child.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n')
          try { await waitFor(() => { assert.ok(!exited, `Pi exited: ${stderr}`); return response }, `${type}: ${stderr}`) }
          finally { pending.delete(id) }
          assert.equal(response.success, true, `${type}: ${response.error ?? stderr}`)
          return response.data
        },
        async prompt(message) {
          const before = events.length
          const response = await rpc.send('prompt', { message })
          if (response?.disposition !== 'handled') await waitFor(() => events.slice(before).some(e => e.type === 'agent_settled'), `agent settled: ${stderr}`)
        },
        async tool(name, args = {}) {
          const before = events.length
          await rpc.prompt(`TEST_TOOL ${JSON.stringify({ name, arguments: args })}`)
          const result = events.slice(before).find(e => e.type === 'tool_execution_end' && e.toolName === name)
          assert.ok(result, `Missing actual tool execution ${name}: ${stderr}`)
          assert.equal(result.isError, false, JSON.stringify(result.result))
          return result.result
        },
        async messages() { return (await rpc.send('get_messages')).messages },
        async ready(file) {
          return waitFor(() => { assert.ok(!exited, `Pi exited: ${stderr}`); if (!fs.existsSync(file)) return false; let status; try { status = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return false }; assert.ok(!status.error, `Readiness error: ${status.error}`); return status.ready === true && status }, `readiness file ${file}; ${stderr}`)
        },
        async close() {
          if (!exited) {
            child.stdin.end()
            if (!await Promise.race([new Promise(resolve => child.once('exit', () => resolve(true))), sleep(1000).then(() => false)])) {
              child.kill('SIGTERM')
              if (!await Promise.race([new Promise(resolve => child.once('exit', () => resolve(true))), sleep(1000).then(() => false)])) {
                child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve))
              }
            }
          }
          processes.delete(rpc)
        },
      }
      processes.add(rpc)
      return rpc
    },
  }
}

export async function persistedDelivery(rpc, needle) {
  const state = await rpc.send('get_state')
  assert.ok(state.sessionFile, 'These tests require a persisted Pi session, not --no-session')
  return waitFor(() => jsonLines(state.sessionFile).find(e => e.type === 'message' && e.message?.role === 'user'
    && messageText(e.message).includes(needle) && deliveryHeader.test(messageText(e.message))), `persisted native user delivery ${needle}`)
}
