// GitHub side of replies and reactions, through the local `gh` login.
// The issue-channel server stays read-only toward GitHub; only agents post.
import { execFile } from 'node:child_process'

export function ghComment(repo, issue, body) {
  return new Promise((resolve, reject) => {
    const child = execFile('gh', ['issue', 'comment', String(issue), '-R', repo, '--body-file', '-'], { timeout: 30000 },
      (err, stdout, stderr) => err ? reject(new Error(`gh issue comment failed: ${stderr || err.message}`)) : resolve(stdout.trim()))
    child.stdin.end(body)
  })
}

// Run `gh api`, never throwing: {ok, status, json, error}. status is the HTTP code when gh reports one.
export function ghApi(args) {
  return new Promise(resolve => {
    execFile('gh', ['api', ...args], { timeout: 20000 }, (err, stdout, stderr) => {
      if (!err) {
        let json = null
        try { json = stdout.trim() ? JSON.parse(stdout) : null } catch {}
        return resolve({ ok: true, status: 200, json })
      }
      const m = String(stderr).match(/HTTP (\d{3})/)
      resolve({ ok: false, status: m ? Number(m[1]) : 0, error: String(stderr || err.message).trim() })
    })
  })
}

let ghLogin
export async function myLogin() {
  if (ghLogin === undefined) {
    const r = await ghApi(['user'])
    ghLogin = r.ok ? r.json.login : null
  }
  return ghLogin
}
