// Pure logic for the issuechan channel: buffering, /bot trigger parsing, formatting.

export const BOT_MARKER = '<!-- issue-channel:bot -->'

// `/bot` alone, `/bot <session>` (single token on the first line), or `/bot <free text>`.
export function parseTrigger(body) {
  const text = (body ?? '').replace(/^\s+/, '')
  const m = text.match(/^\/bot(?=\s|$)([^\n]*)/)
  if (!m) return null
  const rest = m[1].trim()
  const token = /^[A-Za-z0-9_.-]+$/.test(rest) ? rest : null
  return { target: token }
}

// Decide whether a trigger addressed to `target` is for this session.
// Unknown one-word targets (e.g. "/bot hi") are treated as untargeted.
export function isForSession(trigger, session, activeSessions) {
  if (!trigger.target) return true
  if (trigger.target === session) return true
  return !activeSessions.includes(trigger.target)
}

// Per-subscription buffer of new/edited content since the last delivery.
export class IssueBuffer {
  constructor({ allowedAuthors }) {
    this.allowed = new Set(allowedAuthors.map(a => a.toLowerCase()))
    this.items = new Map()
    this.delivered = new Map() // key -> body the agent last received
    this.title = null
  }

  allowedAuthor(login) {
    return login != null && this.allowed.has(login.toLowerCase())
  }

  // Returns a trigger object when this event should flush the buffer, else null.
  // Only newly created /bot comments trigger; edits just update the buffer.
  add(ev) {
    if (ev.title) this.title = ev.title
    if (ev.event === 'issue_comment') {
      const key = `comment:${ev.comment_id}`
      if (ev.action === 'deleted') {
        this.items.delete(key)
        // Tell the agent when a comment it has already seen disappears.
        if (this.delivered.has(key)) {
          this.items.set(key, { kind: 'comment', id: ev.comment_id, action: 'deleted', author: ev.author, body: this.delivered.get(key), at: ev.updated_at, seq: ev.seq })
        }
        return null
      }
      if (ev.action !== 'created' && ev.action !== 'edited') return null
      if ((ev.body ?? '').includes(BOT_MARKER)) return null
      if (!this.allowedAuthor(ev.author)) return null
      const body = ev.body ?? ''
      const seen = this.delivered.get(key)
      if (seen === body) { this.items.delete(key); return null } // edited back to what the agent saw
      this.items.delete(key)
      this.items.set(key, {
        kind: 'comment', id: ev.comment_id, action: ev.action, author: ev.author, body, at: ev.updated_at, seq: ev.seq,
        previous: ev.action === 'edited' ? seen : undefined,
      })
      const trig = ev.action === 'created' ? parseTrigger(body) : null
      return trig ? { ...trig, author: ev.author, comment_id: ev.comment_id, seq: ev.seq } : null
    }
    if (ev.event === 'issues' && (ev.action === 'edited' || ev.action === 'opened')) {
      if (!this.allowedAuthor(ev.author) || (ev.body ?? '').includes(BOT_MARKER)) return null
      const body = ev.body ?? ''
      const seen = this.delivered.get('issue')
      if (seen === body) { this.items.delete('issue'); return null }
      this.items.delete('issue')
      this.items.set('issue', { kind: 'issue', action: ev.action, author: ev.author, body, at: ev.updated_at, seq: ev.seq, previous: seen })
    }
    return null
  }

  // Record what the agent saw before this process started (used to diff later edits).
  markDelivered(ev) {
    if (ev.event === 'issue_comment') {
      const key = `comment:${ev.comment_id}`
      if (ev.action === 'deleted') this.delivered.delete(key)
      else if ((ev.action === 'created' || ev.action === 'edited') && this.allowedAuthor(ev.author) && !(ev.body ?? '').includes(BOT_MARKER)) {
        this.delivered.set(key, ev.body ?? '')
      }
    } else if (ev.event === 'issues' && (ev.action === 'edited' || ev.action === 'opened') && this.allowedAuthor(ev.author)) {
      this.delivered.set('issue', ev.body ?? '')
    }
    if (ev.title) this.title = ev.title
  }

  drain() {
    const items = [...this.items.values()].sort((a, b) => a.seq - b.seq)
    this.items.clear()
    for (const it of items) {
      const key = it.kind === 'issue' ? 'issue' : `comment:${it.id}`
      if (it.action === 'deleted') this.delivered.delete(key)
      else this.delivered.set(key, it.body)
    }
    return items
  }
}

// Minimal line diff (LCS); fine for issue-comment sized text.
export function lineDiff(a, b) {
  const x = a.split('\n'), y = b.split('\n')
  const n = x.length, m = y.length
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  }
  const out = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push(`  ${x[i]}`); i++; j++ } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`- ${x[i++]}`)
    else out.push(`+ ${y[j++]}`)
  }
  while (i < n) out.push(`- ${x[i++]}`)
  while (j < m) out.push(`+ ${y[j++]}`)
  return out.join('\n')
}

// Which agent harness runs this channel, and its session id: { agent, id } or null.
// One entry per harness; add pi / codex here once their session id env vars are known.
// ISSUECHAN_AGENT_ID=<agent>:<id> overrides detection (for wrappers or unknown harnesses).
const AGENT_ENV = [
  ['cc', 'CLAUDE_CODE_SESSION_ID'],
]
const AGENT_RE = /^[a-z][a-z0-9]*$/
const ID_RE = /^[A-Za-z0-9-]+$/

export function resolveAgent(env) {
  const o = (env.ISSUECHAN_AGENT_ID ?? '').match(/^([^:]+):(.+)$/)
  if (o && AGENT_RE.test(o[1]) && ID_RE.test(o[2])) return { agent: o[1], id: o[2] }
  for (const [agent, key] of AGENT_ENV) {
    if (ID_RE.test(env[key] ?? '')) return { agent, id: env[key] }
  }
  return null
}

// Who wrote a reply: "<name> · <agent>:<id8>", dropping the name when it is "default"
// and the id when the harness gives none. "" when neither is known.
export function replyTag({ name, agent }) {
  const parts = []
  if (name && name !== 'default') parts.push(name)
  if (agent) parts.push(`${agent.agent}:${agent.id.slice(0, 8)}`)
  return parts.join(' · ')
}

// Reply layout on the issue: "🤖 <tag> · <summary>", then a clickable "Full reply" toggle.
export function formatReply({ summary, body, tag }) {
  const line = String(summary ?? '').replace(/\s+/g, ' ').trim()
  if (!line) throw new Error('summary is required')
  const full = String(body ?? '').trim()
  if (!full) throw new Error('body is required')
  const head = tag ? `🤖 ${tag} · ${line}` : `🤖 ${line}`
  const esc = head.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `${esc}\n\n<details>\n<summary>Full reply</summary>\n\n${full}\n\n</details>\n\n${BOT_MARKER}\n`
}

export function formatDelivery({ repo, issue, title, trigger, items }) {
  const head = `GitHub issue ${repo}#${issue}${title ? ` "${title}"` : ''}: /bot from @${trigger.author}` +
    (trigger.target ? ` (to session ${trigger.target})` : '')
  const parts = items.map(it => {
    const label = it.kind === 'issue'
      ? `[issue body · @${it.author} · ${it.action}]`
      : `[comment ${it.id} · @${it.author} · ${it.action}${it.at ? ` · ${it.at}` : ''}]`
    if (it.action === 'deleted') return `${label}\nThis comment you saw earlier was deleted. It said:\n${it.body}`
    if (it.previous != null) return `${label}\nChanged since you last saw it:\n\`\`\`diff\n${lineDiff(it.previous, it.body)}\n\`\`\`\nFull text now:\n${it.body}`
    return `${label}\n${it.body}`
  })
  return `${head}\n${items.length} new/edited item(s) since the last delivery:\n\n${parts.join('\n\n')}`
}
