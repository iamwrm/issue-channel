#!/usr/bin/env node
// Save an issue and all its comments as JSON before rewriting or deleting anything.
//   backup-issue.mjs owner/repo#12 | https://github.com/owner/repo/issues/12
//   backup-issue.mjs ENG-123 | linear:ENG#123 | https://linear.app/<ws>/issue/ENG-123/...
// Writes ~/.local/state/issue-channel/backups/backup-<owner>-<repo>-<n>-<ts>.json (GitHub) or
// backup-linear-<ENG-123>-<ts>.json (Linear) and prints the path and the comment count.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DIR = process.env.ISSUECHAN_BACKUP_DIR ?? path.join(os.homedir(), '.local/state/issue-channel/backups')
const ts = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

export function parseRef(ref) {
  const s = String(ref ?? '').trim()
  let m = s.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)/) ?? s.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/)
  if (m) return { kind: 'github', owner: m[1], repo: m[2], number: Number(m[3]) }
  m = s.match(/linear\.app\/[^/]+\/issue\/([A-Za-z0-9]+)-(\d+)/) ?? s.match(/^linear:([A-Za-z0-9]+)#(\d+)$/) ?? s.match(/^([A-Za-z][A-Za-z0-9]*)-(\d+)$/)
  if (m) return { kind: 'linear', identifier: `${m[1].toUpperCase()}-${m[2]}` }
  return null
}

async function main() {
  const ref = parseRef(process.argv[2])
  if (!ref) { console.error('usage: backup-issue.mjs <owner/repo#N | GitHub URL | ENG-123 | linear:ENG#123 | Linear URL>'); process.exit(2) }
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
  let file, data, count
  if (ref.kind === 'github') {
    const gh = args => execFileSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 })
    const issue = JSON.parse(gh([`repos/${ref.owner}/${ref.repo}/issues/${ref.number}`]))
    // One comment per line works on every gh version (--slurp is newer).
    const comments = gh(['--paginate', '--jq', '.[] | tojson', `repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?per_page=100`])
      .split('\n').filter(Boolean).map(l => JSON.parse(l))
    data = { issue, comments, saved_at: new Date().toISOString() }
    count = comments.length
    file = path.join(DIR, `backup-${ref.owner}-${ref.repo}-${ref.number}-${ts()}.json`)
  } else {
    const { gql } = await import('../../../core/linear.mjs')
    const d = await gql(`query($id: String!) { issue(id: $id) { id identifier title url description createdAt state { name type } team { key }
      comments(first: 250) { nodes { id createdAt updatedAt body parent { id } user { name email } reactions { emoji user { name } } } } } }`, { id: ref.identifier })
    if (!d.issue) throw new Error(`Linear issue ${ref.identifier} not found`)
    data = { issue: d.issue, saved_at: new Date().toISOString() }
    count = d.issue.comments.nodes.length
    file = path.join(DIR, `backup-linear-${ref.identifier}-${ts()}.json`)
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 1), { mode: 0o600 })
  console.log(`${file}\n${count} comment(s)`)
}

if (import.meta.url === `file://${fs.realpathSync(process.argv[1])}`) main().catch(e => { console.error(`backup-issue.mjs: ${e.message}`); process.exit(1) })
