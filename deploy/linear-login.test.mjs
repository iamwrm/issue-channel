// deploy/linear-login.mjs against a fake Linear token endpoint: secret path, scopes/actor, PKCE exchange,
// merged linear.env (0600), webhook secret into .env.
import { fileURLToPath } from 'node:url'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'

let tokenServer, login, state, exchanges = []
const SECRET = 'a'.repeat(32)
const PORT = 18000 + Math.floor(Math.random() * 1000)
const base = `http://127.0.0.1:${PORT}/${SECRET}`
const sleep = ms => new Promise(r => setTimeout(r, ms))

before(async () => {
  state = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-login-'))
  fs.writeFileSync(path.join(state, 'linear.env'), 'LINEAR_API_KEY=old\nLINEAR_ALLOWED_AUTHORS=me@example.com\n')
  fs.writeFileSync(path.join(state, '.env'), 'WEBHOOK_SECRET=w\nAPI_KEY=k\n')
  tokenServer = http.createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    exchanges.push(new URLSearchParams(raw))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ access_token: 'acc', refresh_token: 'ref', expires_in: 86400, scope: 'read write comments:create admin' }))
  })
  await new Promise(r => tokenServer.listen(0, '127.0.0.1', r))
  login = spawn(process.execPath, [fileURLToPath(new URL('./linear-login.mjs', import.meta.url))], { stdio: 'ignore', env: {
    PATH: process.env.PATH, PORT: String(PORT), LOGIN_SECRET: SECRET, PUBLIC_URL: 'https://tunnel.example', ISSUECHAN_STATE: state,
    DONE_FILE: path.join(state, 'done'), LINEAR_OAUTH_TOKEN_URL: `http://127.0.0.1:${tokenServer.address().port}/oauth/token` } })
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/`); break } catch { await sleep(50) } }
})
after(() => { login.kill(); tokenServer.close(); fs.rmSync(state, { recursive: true, force: true }) })

const start = fields => fetch(`${base}/start`, { method: 'POST', redirect: 'manual', body: new URLSearchParams(fields) })

test('only the secret path answers; the page offers "act as the app" unticked', async () => {
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/`)).status, 404)
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/${'b'.repeat(32)}/`)).status, 404)
  const html = await (await fetch(`${base}/`)).text()
  assert.match(html, /https:\/\/tunnel\.example\/a{32}\/callback/)
  assert.match(html, /<input type=checkbox name=actor_app>/, 'unticked by default: the agent acts as the user')
})

test('authorize URL: as the user with admin by default; as the app without admin', async () => {
  const user = new URL((await start({ client_id: 'cid' })).headers.get('location'))
  assert.equal(user.origin + user.pathname, 'https://linear.app/oauth/authorize')
  assert.equal(user.searchParams.get('scope'), 'read,write,comments:create,admin')
  assert.equal(user.searchParams.get('actor'), null)
  assert.equal(user.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(user.searchParams.get('redirect_uri'), 'https://tunnel.example/' + SECRET + '/callback')
  const app = new URL((await start({ client_id: 'cid', actor_app: 'on' })).headers.get('location'))
  assert.equal(app.searchParams.get('scope'), 'read,write,comments:create')
  assert.equal(app.searchParams.get('actor'), 'app')
})

test('callback: PKCE exchange, tokens merged into linear.env (0600), webhook secret into .env; state is one-time', async () => {
  const loc = new URL((await start({ client_id: 'cid', webhook_secret: 'whsec' })).headers.get('location'))
  const challenge = loc.searchParams.get('code_challenge')
  const r = await fetch(`${base}/callback?code=the-code&state=${loc.searchParams.get('state')}`)
  assert.equal(r.status, 200)
  const ex = exchanges.at(-1)
  assert.equal(ex.get('code'), 'the-code')
  assert.equal(crypto.createHash('sha256').update(ex.get('code_verifier')).digest('base64url'), challenge, 'verifier matches the challenge')
  const env = fs.readFileSync(path.join(state, 'linear.env'), 'utf8')
  assert.match(env, /LINEAR_ACCESS_TOKEN=acc/)
  assert.match(env, /LINEAR_REFRESH_TOKEN=ref/)
  assert.match(env, /LINEAR_ACTOR=user/)
  assert.match(env, /LINEAR_ALLOWED_AUTHORS=me@example\.com/, 'other settings kept')
  assert.doesNotMatch(env, /LINEAR_API_KEY/, 'the OAuth login replaces a personal key')
  assert.equal(fs.statSync(path.join(state, 'linear.env')).mode & 0o777, 0o600)
  const dotenv = fs.readFileSync(path.join(state, '.env'), 'utf8')
  assert.match(dotenv, /WEBHOOK_SECRET=w\nAPI_KEY=k\nLINEAR_WEBHOOK_SECRET=whsec\n/)
  assert.equal(fs.readFileSync(path.join(state, 'done'), 'utf8'), 'user webhook-secret\n')
  assert.equal((await fetch(`${base}/callback?code=x&state=${loc.searchParams.get('state')}`)).status, 400, 'a state works once')
})

test('local login needs no tunnel, uses the default scopes, saves tokens privately, and stops after success', { timeout: 10000 }, async () => {
  const localState = fs.mkdtempSync(path.join(os.tmpdir(), 'linear local # '))
  let output = ''
  const localLogin = spawn(process.execPath, [fileURLToPath(new URL('./linear-login-local.mjs', import.meta.url))], { stdio: ['ignore', 'ignore', 'pipe'], env: {
    PATH: process.env.PATH, PORT: String(PORT + 2000), ISSUECHAN_STATE: localState,
    LINEAR_OAUTH_TOKEN_URL: `http://127.0.0.1:${tokenServer.address().port}/oauth/token`,
  } })
  localLogin.stderr.on('data', data => { output += data })
  try {
    let localBase
    for (let i = 0; i < 50; i++) {
      localBase = output.match(/Login page: (http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+)\//)?.[1]
      if (localBase) { try { await fetch(localBase + '/'); break } catch {} }
      await sleep(50)
    }
    assert.ok(localBase, 'prints the local login page')
    assert.doesNotMatch(output, /access_token|refresh_token|acc|ref\n/)
    const page = await (await fetch(localBase + '/')).text()
    assert.match(page, /read,write,comments:create,admin<\/code>/, 'same default scopes as the tunneled login')
    assert.equal((await fetch(new URL('/', localBase))).status, 404)
    const start = await fetch(localBase + '/start', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ client_id: 'local-client' }) })
    const authorize = new URL(start.headers.get('location'))
    assert.equal(authorize.searchParams.get('scope'), 'read,write,comments:create,admin')
    assert.equal(authorize.searchParams.get('redirect_uri'), localBase + '/callback')
    const exited = once(localLogin, 'exit')
    assert.equal((await fetch(localBase + '/callback?code=local-code&state=' + authorize.searchParams.get('state'))).status, 200)
    assert.match(fs.readFileSync(path.join(localState, 'linear.env'), 'utf8'), /LINEAR_ACCESS_TOKEN=acc/)
    assert.equal(fs.statSync(path.join(localState, 'linear.env')).mode & 0o777, 0o600)
    assert.equal((await exited)[0], 0)
  } finally { localLogin.kill(); fs.rmSync(localState, { recursive: true, force: true }) }
})
