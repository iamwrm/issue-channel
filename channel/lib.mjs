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
    this.title = null
  }

  allowedAuthor(login) {
    return login != null && this.allowed.has(login.toLowerCase())
  }

  // Returns a trigger object when this event should flush the buffer, else null.
  add(ev) {
    if (ev.title) this.title = ev.title
    if (ev.event === 'issue_comment') {
      const key = `comment:${ev.comment_id}`
      if (ev.action === 'deleted') { this.items.delete(key); return null }
      if (ev.action !== 'created' && ev.action !== 'edited') return null
      if ((ev.body ?? '').includes(BOT_MARKER)) return null
      if (!this.allowedAuthor(ev.author)) return null
      this.items.delete(key)
      this.items.set(key, { kind: 'comment', id: ev.comment_id, action: ev.action, author: ev.author, body: ev.body ?? '', at: ev.updated_at, seq: ev.seq })
      const trig = parseTrigger(ev.body)
      return trig ? { ...trig, author: ev.author, comment_id: ev.comment_id, seq: ev.seq } : null
    }
    if (ev.event === 'issues' && (ev.action === 'edited' || ev.action === 'opened')) {
      if (!this.allowedAuthor(ev.author) || (ev.body ?? '').includes(BOT_MARKER)) return null
      this.items.delete('issue')
      this.items.set('issue', { kind: 'issue', action: ev.action, author: ev.author, body: ev.body ?? '', at: ev.updated_at, seq: ev.seq })
    }
    return null
  }

  drain() {
    const items = [...this.items.values()].sort((a, b) => a.seq - b.seq)
    this.items.clear()
    return items
  }
}

export function formatDelivery({ repo, issue, title, trigger, items }) {
  const head = `GitHub issue ${repo}#${issue}${title ? ` "${title}"` : ''}: /bot from @${trigger.author}` +
    (trigger.target ? ` (to session ${trigger.target})` : '')
  const parts = items.map(it => {
    const label = it.kind === 'issue'
      ? `[issue body · @${it.author} · ${it.action}]`
      : `[comment ${it.id} · @${it.author} · ${it.action}${it.at ? ` · ${it.at}` : ''}]`
    return `${label}\n${it.body}`
  })
  return `${head}\n${items.length} new/edited item(s) since the last delivery:\n\n${parts.join('\n\n')}`
}
