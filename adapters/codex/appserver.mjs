// Minimal JSON-RPC client for a running `codex app-server --listen unix://<sock>`.
// The unix socket speaks WebSocket (one JSON-RPC message per frame), not JSONL.
import fs from 'node:fs'
import WebSocket from 'ws'

export class AppServer {
  constructor(sock, { name = 'issuechan', version = '0.1.0', log = () => {} } = {}) {
    this.sock = sock
    this.info = { name, title: null, version }
    this.log = log
    this.ws = null
    this.ready = null // Promise of an initialized connection
    this.next = 1
    this.pending = new Map()
    this.joined = new Set() // threads this connection has resumed
  }

  connect() {
    if (this.ready) return this.ready
    this.ready = new Promise((resolve, reject) => {
      // `--listen unix://PATH` makes PATH a symlink to a short socket under /tmp/codex-daemon-<uid>/.
      // Connect to the target: a long PATH can exceed the unix socket path limit (~108 bytes, EINVAL).
      let target = this.sock
      try { target = fs.realpathSync(this.sock) } catch {}
      const ws = new WebSocket(`ws+unix://${target}:/`)
      ws.once('error', reject)
      ws.once('open', () => {
        this.ws = ws
        this.call('initialize', { clientInfo: this.info, capabilities: null })
          .then(() => { ws.send(JSON.stringify({ method: 'initialized' })); resolve() }, reject)
      })
      ws.on('message', data => this.onMessage(String(data)))
      ws.on('close', () => this.reset(new Error('app-server connection closed')))
    }).catch(e => { this.reset(e); throw e })
    return this.ready
  }

  reset(err) {
    this.ws?.removeAllListeners()
    this.ws?.terminate()
    this.ws = null
    this.ready = null
    this.joined.clear()
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  onMessage(line) {
    let m
    try { m = JSON.parse(line) } catch { return }
    if (m.id != null && !m.method) {
      const p = this.pending.get(m.id)
      this.pending.delete(m.id)
      if (m.error) p?.reject(Object.assign(new Error(m.error.message), { code: m.error.code }))
      else p?.resolve(m.result)
    }
    // Server requests (approvals, user input, auth refresh) go to every client on the thread, and the
    // first answer wins: an instant decline here would beat the user's click in the GUI or TUI.
    // We are not a UI, so leave them for the client that is.
    // Notifications (turn/*, item/*) are ignored: the agent's own UI renders them.
  }

  call(method, params) {
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  // Hand `text` to the thread as user input: starts a turn when idle, steers the running turn
  // when busy (turn/start on a busy thread is accepted as a steer and returns that turn's id).
  // Only to a thread a UI already has loaded here: resuming it ourselves would run turns no one sees
  // (e.g. issuechan started by a plain `codex`, whose thread lives in its own embedded app-server).
  async send(threadId, text) {
    await this.connect()
    if (!this.joined.has(threadId)) {
      if (!(await this.loadedThreads()).includes(threadId)) throw new Error(`thread ${threadId} is not loaded in the app-server at ${this.sock}`)
      await this.call('thread/resume', { threadId })
      this.joined.add(threadId)
    }
    const { turn } = await this.call('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] })
    return turn.id
  }

  // Ids of the threads loaded in the app-server.
  async loadedThreads() {
    await this.connect()
    const ids = []
    for (let cursor = null; ;) {
      const r = await this.call('thread/loaded/list', { cursor })
      ids.push(...r.data)
      if (!(cursor = r.nextCursor)) return ids
    }
  }

  async threadCwd(threadId) {
    await this.connect()
    return (await this.call('thread/read', { threadId })).thread.cwd
  }

  close() { this.reset(new Error('closed')) }
}
