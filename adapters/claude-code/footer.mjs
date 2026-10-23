// Reply footer stats for a Claude Code session, read from what Claude Code already writes: the model and context use
// from the last main-thread assistant turn in the session transcript, the effort level from the environment or the
// user settings, and the context window from the model id (ISSUECHAN_CONTEXT_WINDOW overrides it).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TAIL_BYTES = 1 << 20

export function footerStats(id, { env = process.env, home = os.homedir() } = {}) {
  if (!id) return {}
  const dir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
  const turn = lastTurn(transcript(path.join(dir, 'projects'), id))
  const model = turn?.model
  const u = turn?.usage
  return {
    model,
    thinking: env.CLAUDE_EFFORT || effort(path.join(dir, 'settings.json'), model),
    used: u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : undefined,
    window: Number(env.ISSUECHAN_CONTEXT_WINDOW) || contextWindow(model),
  }
}

// Claude 5 models and "[1m]" ids have a 1M-token window; other Claude models 200k.
export function contextWindow(model) {
  if (!model) return undefined
  if (/\[1m\]$/i.test(model) || /^claude-(opus|sonnet|fable)-5/.test(model)) return 1_000_000
  return /^claude-/.test(model) ? 200_000 : undefined
}

function transcript(projects, id) {
  let dirs
  try { dirs = fs.readdirSync(projects) } catch { return undefined }
  for (const d of dirs) {
    const f = path.join(projects, d, `${id}.jsonl`)
    if (fs.existsSync(f)) return f
  }
}

function lastTurn(file) {
  if (!file) return undefined
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size, len = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      let e
      try { e = JSON.parse(lines[i]) } catch { continue }
      const m = e?.message
      if (e?.type === 'assistant' && !e.isSidechain && m?.usage && m.model && m.model !== '<synthetic>') return m
    }
  } finally { fs.closeSync(fd) }
}

function effort(file, model) {
  let s
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return undefined }
  return (model && s?.modelSettings?.[model]?.effortLevel) || s?.effortLevel || undefined
}
