#!/usr/bin/env node
// One-time Linear OAuth login (authorization code + PKCE) served behind a temporary quick tunnel by
// `deploy/issue-channel.sh linear-login`. Linear has no device-code flow, so this is the closest thing:
// open https://<tunnel>/<LOGIN_SECRET>/, approve in Linear, and the tokens land in $STATE/linear.env (0600).
// Default: the agent acts as YOU (replies, 👀 and ✅ show as you; scopes include admin). LINEAR_LOGIN_SCOPES
// overrides the requested scopes (the local wrapper omits admin). Tick "act as the app"
// to have it act as the OAuth app instead (Linear refuses admin for app users).
// Other keys already in linear.env (allowlist, ...) are kept. Tokens are never printed or logged.
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const PORT = Number(process.env.PORT ?? 8795)
const SECRET = process.env.LOGIN_SECRET
const PUBLIC = process.env.PUBLIC_URL // https://<tunnel>
const STATE = process.env.ISSUECHAN_STATE ?? path.join(os.homedir(), '.local/share/issue-channel')
const OUT = process.env.ISSUECHAN_LINEAR_ENV_FILE ?? path.join(STATE, 'linear.env')
const DONE_FILE = process.env.DONE_FILE // written after a successful login (the shell wrapper waits for it)
const TOKEN_URL = process.env.LINEAR_OAUTH_TOKEN_URL ?? 'https://api.linear.app/oauth/token'
if (!SECRET || !PUBLIC) { console.error('LOGIN_SECRET and PUBLIC_URL required'); process.exit(2) }
const base = `/${SECRET}`
const redirectUri = `${PUBLIC}${base}/callback`
const pending = new Map() // state -> { verifier, clientId, clientSecret, webhookSecret, actor, at }

const readEnv = file => {
  try {
    return Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').map(l => l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]))
  } catch { return {} }
}
const writeEnv = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file + '.tmp', Object.entries(obj).map(([k, v]) => `${k}=${v ?? ''}`).join('\n') + '\n', { mode: 0o600 })
  fs.renameSync(file + '.tmp', file)
}

const page = (title, html) => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>${title}</title>
<body style="font:16px system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem"><h2>${title}</h2>${html}</body>`
const send = (res, code, html) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html) }
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

async function form(req) {
  let s = ''
  for await (const c of req) { s += c; if (s.length > 10000) throw new Error('too large') }
  return new URLSearchParams(s)
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x')
    if (!url.pathname.startsWith(base + '/') && url.pathname !== base) return send(res, 404, 'not found')
    const route = url.pathname.slice(base.length) || '/'
    if (req.method === 'GET' && route === '/') {
      const known = readEnv(OUT).LINEAR_CLIENT_ID ?? ''
      return send(res, 200, page('issue-channel: Linear login', `
<p>1. In Linear: <b>Settings → API → OAuth applications</b>, create (or open) an app and add this <b>callback URL</b>:<br><code>${esc(redirectUri)}</code></p>
<p>2. Paste its client ID (the client secret is optional with PKCE; add it if the token exchange asks for it).</p>
<p>Requested scopes: <code>${esc(process.env.LINEAR_LOGIN_SCOPES ?? 'read,write,comments:create,admin')}</code>. App-actor login always excludes admin.</p>
<form method=post action="${base}/start">
<p><input name=client_id placeholder="client id" value="${esc(known)}" required style="width:100%;font:inherit"></p>
<p><input name=client_secret placeholder="client secret (optional)" type=password style="width:100%;font:inherit"></p>
<p><input name=webhook_secret placeholder="webhook signing secret (optional; saved to .env as LINEAR_WEBHOOK_SECRET)" type=password style="width:100%;font:inherit"></p>
<p><label><input type=checkbox name=actor_app> act as the app instead of me (no admin scope then)</label></p>
<p><button style="font:inherit">Continue to Linear</button></p></form>`))
    }
    if (req.method === 'POST' && route === '/start') {
      const f = await form(req)
      const clientId = f.get('client_id')?.trim()
      if (!clientId) return send(res, 400, page('Missing client id', ''))
      const actor = f.get('actor_app') ? 'app' : 'user'
      const verifier = crypto.randomBytes(48).toString('base64url')
      const state = crypto.randomBytes(24).toString('base64url')
      pending.set(state, { verifier, clientId, clientSecret: f.get('client_secret')?.trim() || '', webhookSecret: f.get('webhook_secret')?.trim() || '', actor, at: Date.now() })
      const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', prompt: 'consent', state,
        // Linear refuses the admin scope for app users.
        scope: (process.env.LINEAR_LOGIN_SCOPES ?? 'read,write,comments:create,admin').split(',')
          .map(s => s.trim()).filter(s => s && (actor !== 'app' || s !== 'admin')).join(','),
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })
      if (actor === 'app') q.set('actor', 'app')
      res.writeHead(303, { location: `https://linear.app/oauth/authorize?${q}` })
      return res.end()
    }
    if (req.method === 'GET' && route === '/callback') {
      const st = url.searchParams.get('state') ?? ''
      const p = pending.get(st)
      if (!p || Date.now() - p.at > 15 * 60e3) return send(res, 400, page('Unknown or expired login', '<p>Start again from the first page.</p>'))
      if (url.searchParams.get('error')) return send(res, 400, page('Linear returned an error', `<p>${esc(url.searchParams.get('error'))}</p>`))
      const body = new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code') ?? '', redirect_uri: redirectUri,
        client_id: p.clientId, code_verifier: p.verifier })
      if (p.clientSecret) body.set('client_secret', p.clientSecret)
      const r = await fetch(TOKEN_URL, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } })
      const tok = await r.json().catch(() => ({}))
      if (!r.ok || !tok.access_token) {
        return send(res, 400, page('Token exchange failed', `<p>HTTP ${r.status}: ${esc(tok.error_description ?? tok.error ?? '')}</p><p>If it mentions the client secret, start again and add it.</p>`))
      }
      pending.delete(st)
      const prev = readEnv(OUT)
      delete prev.LINEAR_API_KEY // an OAuth login replaces a personal key
      writeEnv(OUT, {
        ...prev, LINEAR_CLIENT_ID: p.clientId, ...(p.clientSecret ? { LINEAR_CLIENT_SECRET: p.clientSecret } : {}),
        LINEAR_ACCESS_TOKEN: tok.access_token, LINEAR_REFRESH_TOKEN: tok.refresh_token ?? '',
        LINEAR_TOKEN_EXPIRES_AT: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : '',
        LINEAR_SCOPE: tok.scope ?? '', LINEAR_ACTOR: p.actor,
      })
      if (p.webhookSecret) writeEnv(path.join(STATE, '.env'), { ...readEnv(path.join(STATE, '.env')), LINEAR_WEBHOOK_SECRET: p.webhookSecret })
      if (DONE_FILE) fs.writeFileSync(DONE_FILE, `${p.actor}${p.webhookSecret ? ' webhook-secret' : ''}\n`)
      if (process.env.ISSUECHAN_LOGIN_EXIT_ON_DONE === '1') {
        setTimeout(() => server.close(), 1000).unref()
      }
      return send(res, 200, page('Done', '<p>The token is stored on the host. You can close this tab.</p>'))
    }
    send(res, 404, 'not found')
  } catch (e) { send(res, 500, page('Error', esc(e.message))) }
}).listen(PORT, '127.0.0.1', () => console.error(`linear-login on 127.0.0.1:${PORT}`))
