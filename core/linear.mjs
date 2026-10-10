// Linear side of replies and reactions, through Linear's GraphQL API.
// Credentials live in ISSUECHAN_LINEAR_ENV_FILE (default ~/.local/share/issue-channel/linear.env, mode 0600):
//   LINEAR_ACCESS_TOKEN + LINEAR_REFRESH_TOKEN + LINEAR_CLIENT_ID [+ LINEAR_CLIENT_SECRET]  (OAuth; refreshed here)
//   or LINEAR_API_KEY                                                                       (personal API key)
//   LINEAR_ALLOWED_AUTHORS  comma-separated emails whose /bot comments count (or ISSUECHAN_LINEAR_ALLOWED)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const API_URL = () => process.env.LINEAR_API_URL ?? 'https://api.linear.app/graphql'
const TOKEN_URL = () => process.env.LINEAR_OAUTH_TOKEN_URL ?? 'https://api.linear.app/oauth/token'
export const envFile = () => process.env.ISSUECHAN_LINEAR_ENV_FILE ?? path.join(os.homedir(), '.local/share/issue-channel/linear.env')

export function readCreds(file = envFile()) {
  try {
    return Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n')
      .map(l => l.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]))
  } catch { return {} }
}

function writeCreds(creds, file = envFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file + '.tmp', Object.entries(creds).map(([k, v]) => `${k}=${v ?? ''}`).join('\n') + '\n', { mode: 0o600 })
  fs.renameSync(file + '.tmp', file)
}

// Refresh an OAuth access token shortly before it expires (they last 24 h). Linear may rotate the refresh token.
async function refresh(creds) {
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: creds.LINEAR_REFRESH_TOKEN, client_id: creds.LINEAR_CLIENT_ID })
  if (creds.LINEAR_CLIENT_SECRET) form.set('client_secret', creds.LINEAR_CLIENT_SECRET)
  const r = await fetch(TOKEN_URL(), { method: 'POST', body: form, headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(20000) })
  const tok = await r.json().catch(() => ({}))
  if (!r.ok || !tok.access_token) throw new Error(`Linear token refresh failed: HTTP ${r.status} ${tok.error_description ?? tok.error ?? ''}`)
  const next = { ...readCreds(), LINEAR_ACCESS_TOKEN: tok.access_token, LINEAR_REFRESH_TOKEN: tok.refresh_token ?? creds.LINEAR_REFRESH_TOKEN,
    LINEAR_TOKEN_EXPIRES_AT: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : '' }
  writeCreds(next)
  return next
}

let refreshing = null
async function authHeader({ force = false } = {}) {
  let creds = readCreds()
  if (creds.LINEAR_API_KEY && !creds.LINEAR_ACCESS_TOKEN) return creds.LINEAR_API_KEY
  if (!creds.LINEAR_ACCESS_TOKEN) throw new Error(`no Linear credentials: log in first (see the README), file ${envFile()}`)
  const exp = Date.parse(creds.LINEAR_TOKEN_EXPIRES_AT || '')
  if (creds.LINEAR_REFRESH_TOKEN && (force || (exp && exp - Date.now() < 10 * 60e3))) {
    refreshing ??= refresh(creds).finally(() => { refreshing = null })
    creds = await refreshing
  }
  return `Bearer ${creds.LINEAR_ACCESS_TOKEN}`
}

export async function gql(query, variables = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(API_URL(), {
      method: 'POST', body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json', authorization: await authHeader({ force: attempt > 0 }) },
    })
    const json = await r.json().catch(() => ({}))
    const authErr = r.status === 401 || json.errors?.some(e => e.extensions?.code === 'AUTHENTICATION_ERROR')
    if (authErr && attempt === 0 && readCreds().LINEAR_REFRESH_TOKEN) continue // expired early: refresh once and retry
    if (!r.ok || json.errors?.length) throw new Error(`Linear API: HTTP ${r.status} ${json.errors?.map(e => e.message).join('; ') ?? ''}`.trim())
    return json.data
  }
}

// "linear:ENG" + 123 -> "ENG-123"
export const identifier = (repo, issue) => `${repo.slice('linear:'.length)}-${issue}`

const issueIds = new Map()
async function issueId(repo, issue) {
  const key = identifier(repo, issue)
  if (!issueIds.has(key)) {
    const d = await gql('query($id: String!) { issue(id: $id) { id } }', { id: key })
    if (!d.issue?.id) throw new Error(`Linear issue ${key} not found`)
    issueIds.set(key, d.issue.id)
  }
  return issueIds.get(key)
}

// Who the token acts as (the app user or a person); cached per token, since a re-login switches it.
const viewers = new Map()
export async function viewer() {
  const key = await authHeader()
  if (!viewers.has(key)) viewers.set(key, (await gql('query { viewer { id name email } }')).viewer)
  return viewers.get(key)
}

// Post a comment; with parentId it is a reply in that comment's thread (Linear threads are one level deep).
export async function comment(repo, issue, body, { parentId } = {}) {
  const input = { issueId: await issueId(repo, issue), body }
  if (parentId) input.parentId = parentId
  const d = await gql('mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }', { input })
  if (!d.commentCreate?.success) throw new Error('Linear commentCreate failed')
  return d.commentCreate.comment
}

export async function react(commentId, emoji) {
  const d = await gql('mutation($input: ReactionCreateInput!) { reactionCreate(input: $input) { success reaction { id } } }', { input: { commentId, emoji } })
  return d.reactionCreate?.reaction?.id ?? null
}

export async function unreact(reactionId) {
  const d = await gql('mutation($id: String!) { reactionDelete(id: $id) { success } }', { id: reactionId })
  return !!d.reactionDelete?.success
}

// This app's/user's reactions with a given emoji on a comment; null when the comment is gone.
export async function myReactions(commentId, emoji) {
  const [d, v] = await Promise.all([
    gql('query($id: String!) { comment(id: $id) { id reactions { id emoji user { id } } } }', { id: commentId }).catch(e => {
      if (/not found|Entity not found/i.test(e.message)) return { comment: null }
      throw e
    }),
    viewer(),
  ])
  if (!d.comment) return null
  return d.comment.reactions.filter(r => r.emoji === emoji && r.user?.id === v.id).map(r => r.id)
}

export async function resolveThread(rootId) {
  const d = await gql('mutation($id: String!) { commentResolve(id: $id) { success } }', { id: rootId })
  return !!d.commentResolve?.success
}

export function allowedAuthors() {
  const v = process.env.ISSUECHAN_LINEAR_ALLOWED ?? readCreds().LINEAR_ALLOWED_AUTHORS ?? ''
  return v.split(',').map(s => s.trim()).filter(Boolean)
}
