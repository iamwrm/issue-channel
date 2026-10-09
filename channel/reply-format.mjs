#!/usr/bin/env node
// Print an issue reply in the issue_reply format, for agents that post with gh directly:
//   node reply-format.mjs --summary "One line" --body-file reply.md | gh issue comment N -R owner/name -F -
// The tag comes from the same env as the channel: ISSUECHAN_SESSION and the agent's session id.
import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { formatReply, replyTag, resolveAgent } from './lib.mjs'

const { values: v } = parseArgs({ options: {
  summary: { type: 'string' },
  'body-file': { type: 'string' },
  session: { type: 'string', default: process.env.ISSUECHAN_SESSION || 'default' },
} })
const body = fs.readFileSync(!v['body-file'] || v['body-file'] === '-' ? 0 : v['body-file'], 'utf8')
process.stdout.write(formatReply({ summary: v.summary, body, tag: replyTag({ name: v.session, agent: resolveAgent(process.env) }) }))
