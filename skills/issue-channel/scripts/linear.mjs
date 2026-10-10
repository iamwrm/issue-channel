#!/usr/bin/env node
// Linear operations the issuechan tools don't cover, with the channel's credentials (linear.env).
//   linear.mjs whoami
//   linear.mjs issue ENG-123 [--body-data] [--json]        description + every comment (full ids, threads)
//   linear.mjs comment ENG-123 (--file F | --body TEXT) [--parent ID] [--no-marker]
//   linear.mjs delete-comment ID [ID ...]                   replies first: deleting a parent deletes its thread
//   linear.mjs set-description ENG-123 --file F
//   linear.mjs set-state ENG-123 (completed|canceled|started|backlog|unstarted|<state name>)
import fs from 'node:fs'
import { gql, viewer } from '../../../core/linear.mjs'
import { LINEAR_MARKER } from '../../../core/lib.mjs'

const [cmd, ...rest] = process.argv.slice(2)
const flags = {}, args = []
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) {
    const k = rest[i].slice(2)
    if (['body-data', 'json', 'no-marker'].includes(k)) flags[k] = true
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
  async 'delete-comment'(ids) {
    if (!ids.length) die('comment id(s) required')
    let failed = 0
    for (const id of ids) {
      try {
        const d = await gql('mutation($id: String!) { commentDelete(id: $id) { success } }', { id })
        console.log(`${id}: ${d.commentDelete.success ? 'deleted' : 'not deleted'}`)
      } catch (e) {
        failed++
        console.log(`${id}: ${/not found/i.test(e.message) ? 'already gone (or deleted with its thread)' : e.message}`)
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
    const states = i.team.states.nodes.sort((a, b) => a.position - b.position)
    const s = states.find(x => x.name.toLowerCase() === want.toLowerCase()) ?? states.find(x => x.type === want)
    if (!s) die(`no state "${want}"; states: ${states.map(x => `${x.name} (${x.type})`).join(', ')}`)
    const d = await gql('mutation($id: String!, $i: IssueUpdateInput!) { issueUpdate(id: $id, input: $i) { success issue { state { name } } } }', { id: i.id, i: { stateId: s.id } })
    console.log(`state: ${d.issueUpdate.issue.state.name}`)
  },
}

if (import.meta.url === `file://${fs.realpathSync(process.argv[1])}`) {
  const run = commands[cmd] ?? (() => die(`unknown command "${cmd ?? ''}"; see the header of this file`))
  run(args).catch(e => die(e.message))
}
