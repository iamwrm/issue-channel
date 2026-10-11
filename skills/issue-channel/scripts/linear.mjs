#!/usr/bin/env node
// Linear operations the issuechan tools don't cover, with the channel's credentials (linear.env).
//   linear.mjs --help                                  usage without credentials or API calls
//   linear.mjs whoami
//   linear.mjs issue ENG-123 [--body-data] [--json]        description + every comment (full ids, threads)
//   linear.mjs comment ENG-123 (--file F | --body TEXT) [--parent ID] [--no-marker]
//   linear.mjs edit-comment ID (--file F | --body TEXT) [--no-marker]   your own comments
//   linear.mjs delete-comment ID [ID ...]                   replies first: deleting a parent deletes its thread
//   linear.mjs set-description ENG-123 --file F
//   linear.mjs set-state ENG-123 (in-progress|completed|canceled|started|backlog|unstarted|<state name>)
//   linear.mjs create ENG --title T [--description D | --file F] [--state in-progress]   prints {identifier, url, state}
import { isMain } from '../../../core/entrypoint.mjs'
import fs from 'node:fs'
import { gql, viewer } from '../../../core/linear.mjs'
import { LINEAR_MARKER } from '../../../core/lib.mjs'

const HELP = `Usage: linear.mjs <command> [arguments] [options]

Commands:
  whoami
  issue ENG-123 [--body-data] [--json]
  comment ENG-123 (--file F | --body TEXT) [--parent ID] [--no-marker]
  edit-comment ID (--file F | --body TEXT) [--no-marker]
  delete-comment ID [ID ...]
  set-description ENG-123 --file F
  set-state ENG-123 <state name|type|in-progress>
  create ENG --title T [--description D | --file F] [--state in-progress]

Issue refs: ENG-123, linear:ENG#123, or a Linear issue URL.
States: in-progress, completed, canceled, started, backlog, unstarted,
  or a team state name (quote names containing spaces).
Comments include the invisible issue-channel bot marker unless --no-marker is set.
Credentials: ISSUECHAN_LINEAR_ENV_FILE, default ~/.local/share/issue-channel/linear.env.
Help: --help, -h, or help (also <command> --help); no credentials or API calls required.`

const [cmd, ...rest] = process.argv.slice(2)
const flags = {}, args = []
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '-h') flags.help = true
  else if (rest[i].startsWith('--')) {
    const k = rest[i].slice(2)
    if (['body-data', 'json', 'no-marker', 'help'].includes(k)) flags[k] = true
    else flags[k] = rest[++i]
  } else args.push(rest[i])
}
const die = m => { console.error(`linear.mjs: ${m}`); process.exit(2) }
// Accepts ENG-123, linear:ENG#123, or a Linear issue URL.
export function identifier(ref) {
  const m = String(ref ?? '').match(/(?:^|\/issue\/)([A-Za-z0-9]+)-(\d+)/) ?? String(ref ?? '').match(/^linear:([A-Za-z0-9]+)#(\d+)$/)
  if (!m) die(`not a Linear issue ref: ${ref}`)
  return `${m[1].toUpperCase()}-${m[2]}`
}
const text = () => flags.file ? fs.readFileSync(flags.file, 'utf8') : flags.body ?? die('--file or --body required')
// A state by name, by the alias "in-progress" (the "In Progress" state, else the first started one), or by type
// (the team's first state of that type by position; e.g. "started" is In Progress before In Review).
function pickState(states, want) {
  const sorted = [...states].sort((a, b) => a.position - b.position)
  const w = want.toLowerCase()
  if (w === 'in-progress') return sorted.find(x => x.name.toLowerCase() === 'in progress') ?? sorted.find(x => x.type === 'started')
  return sorted.find(x => x.name.toLowerCase() === w) ?? sorted.find(x => x.type === w)
}
const issueId = async ref => (await gql('query($id: String!) { issue(id: $id) { id } }', { id: identifier(ref) })).issue?.id ?? die(`issue ${ref} not found`)

const commands = {
  async whoami() {
    console.log(JSON.stringify(await viewer()))
  },
  async issue([ref]) {
    const d = await gql(`query($id: String!) { issue(id: $id) { identifier title url state { name type } description
      comments(first: 250) { nodes { id createdAt editedAt body ${flags['body-data'] ? 'bodyData' : ''} parent { id } user { name email } reactions { emoji user { name } } } } } }`, { id: identifier(ref) })
    const i = d.issue ?? die(`issue ${ref} not found`)
    const comments = i.comments.nodes.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    if (flags.json) return console.log(JSON.stringify({ ...i, comments }, null, 1))
    console.log(`${i.identifier} "${i.title}" [${i.state.name}] ${i.url}\n\n--- description ---\n${i.description ?? ''}\n`)
    for (const c of comments) {
      const who = c.user?.email ?? c.user?.name ?? '?'
      const r = c.reactions.map(x => `${x.emoji}(${x.user?.name ?? '?'})`).join(' ')
      console.log(`--- comment ${c.id} · ${who} · ${c.createdAt}${c.parent ? ` · reply to ${c.parent.id}` : ''}${c.editedAt ? ' · edited' : ''}${r ? ` · ${r}` : ''}`)
      console.log(c.body)
      if (flags['body-data']) console.log(`bodyData: ${typeof c.bodyData === 'string' ? c.bodyData : JSON.stringify(c.bodyData)}`)
      console.log()
    }
  },
  async comment([ref]) {
    let body = text().trimEnd()
    if (!flags['no-marker'] && !body.includes(LINEAR_MARKER)) body += `\n\n${LINEAR_MARKER}`
    const input = { issueId: await issueId(ref), body: body + '\n' }
    if (flags.parent) input.parentId = flags.parent
    const d = await gql('mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }', { input })
    console.log(JSON.stringify(d.commentCreate.comment))
  },
  async 'edit-comment'([id]) {
    if (!id) die('comment id required')
    let body = text().trimEnd()
    if (!flags['no-marker'] && !body.includes(LINEAR_MARKER)) body += `\n\n${LINEAR_MARKER}`
    const d = await gql('mutation($id: String!, $i: CommentUpdateInput!) { commentUpdate(id: $id, input: $i) { success comment { url } } }', { id, i: { body: body + '\n' } })
    console.log(d.commentUpdate.success ? `updated ${d.commentUpdate.comment.url}` : 'not updated')
  },
  async 'delete-comment'(args) {
    // Accept ids one per argument or whitespace/newline-separated in one argument (zsh doesn't word-split $ids).
    const ids = args.flatMap(a => a.split(/\s+/)).filter(Boolean)
    if (!ids.length) die('comment id(s) required')
    let failed = 0
    for (const id of ids) {
      try {
        const d = await gql('mutation($id: String!) { commentDelete(id: $id) { success } }', { id })
        console.log(`${id}: ${d.commentDelete.success ? 'deleted' : 'not deleted'}`)
      } catch (e) {
        failed++
        console.log(`${id}: ${/Entity not found/i.test(e.message) ? 'already gone (or deleted with its thread)' : e.message}`)
      }
    }
    if (failed) process.exitCode = 1
  },
  async 'set-description'([ref]) {
    const d = await gql('mutation($id: String!, $i: IssueUpdateInput!) { issueUpdate(id: $id, input: $i) { success } }', { id: await issueId(ref), i: { description: text() } })
    console.log(d.issueUpdate.success ? 'description updated' : 'not updated')
  },
  async 'set-state'([ref, want]) {
    if (!want) die('state required (completed, canceled, started, backlog, unstarted, or a state name)')
    const i = (await gql('query($id: String!) { issue(id: $id) { id team { states { nodes { id name type position } } } } }', { id: identifier(ref) })).issue ?? die(`issue ${ref} not found`)
    const states = i.team.states.nodes
    const s = pickState(states, want)
    if (!s) die(`no state "${want}"; states: ${states.map(x => `${x.name} (${x.type})`).join(', ')}`)
    const d = await gql('mutation($id: String!, $i: IssueUpdateInput!) { issueUpdate(id: $id, input: $i) { success issue { state { name } } } }', { id: i.id, i: { stateId: s.id } })
    console.log(`state: ${d.issueUpdate.issue.state.name}`)
  },
  async create([teamKey]) {
    if (!teamKey || !flags.title) die('usage: create <TEAM> --title T [--description D | --file F] [--state in-progress]')
    const team = (await gql('query($k: String!) { teams(filter: {key: {eq: $k}}) { nodes { id states { nodes { id name type position } } } } }', { k: teamKey.toUpperCase() })).teams.nodes[0]
    if (!team) die(`no team ${teamKey}`)
    const input = { teamId: team.id, title: flags.title }
    const description = flags.file ? fs.readFileSync(flags.file, 'utf8') : flags.description
    if (description) input.description = description
    if (flags.state) {
      const s = pickState(team.states.nodes, flags.state)
      if (!s) die(`no state "${flags.state}"`)
      input.stateId = s.id
    }
    const d = await gql('mutation($i: IssueCreateInput!) { issueCreate(input: $i) { success issue { identifier url state { name } } } }', { i: input })
    const iss = d.issueCreate.issue
    console.log(JSON.stringify({ identifier: iss.identifier, url: iss.url, state: iss.state.name }))
  },
}

if (isMain(import.meta.url)) {
  if (!cmd || ['--help', '-h', 'help'].includes(cmd) || flags.help) console.log(HELP)
  else {
    const run = commands[cmd] ?? (() => die(`unknown command "${cmd}"; run linear.mjs --help`))
    run(args).catch(e => die(e.message))
  }
}
