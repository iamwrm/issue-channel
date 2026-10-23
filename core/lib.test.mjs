import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTrigger, isForSession, IssueBuffer, formatDelivery, formatFooter, formatReply, lineDiff, BOT_MARKER, replyTag, resolveAgent } from './lib.mjs'

test('parseTrigger', () => {
  assert.deepEqual(parseTrigger('/bot'), { target: null })
  assert.deepEqual(parseTrigger('  /bot review\nplease look'), { target: 'review' })
  assert.deepEqual(parseTrigger('/bot please fix it'), { target: null })
  assert.equal(parseTrigger('/botany'), null)
  assert.equal(parseTrigger('hello /bot'), null)
  assert.equal(parseTrigger(null), null)
})

test('parseTrigger: !no-compact is matched by code, exactly', () => {
  assert.deepEqual(parseTrigger('/bot !no-compact'), { target: null, command: 'no-compact', text: '' })
  assert.deepEqual(parseTrigger('/bot !no-compact worker1\nwhat did we find?\n'), { target: 'worker1', command: 'no-compact', text: 'what did we find?' })
  assert.deepEqual(parseTrigger('/bot   !no-compact  \n\n continue '), { target: null, command: 'no-compact', text: 'continue' })
  for (const body of ['/bot please !no-compact', '/bot !nocompact', '/bot !no-compact a b', '/bot hi\n!no-compact', '/bot !no-compacted'])
    assert.equal(parseTrigger(body).command, undefined, body)
})

test('isForSession', () => {
  assert.ok(isForSession({ target: null }, 'a', ['a', 'b']))
  assert.ok(isForSession({ target: 'a' }, 'a', []))
  assert.ok(!isForSession({ target: 'b' }, 'a', ['a', 'b']))
  assert.ok(isForSession({ target: 'hi' }, 'a', ['a', 'b']), 'unknown one-word target counts as untargeted')
})

const c = (seq, id, body, action = 'created', author = 'me') =>
  ({ seq, event: 'issue_comment', action, comment_id: id, author, body, title: 'T', updated_at: `t${seq}` })

test('buffer collects allowed new/edited comments and triggers on /bot', () => {
  const b = new IssueBuffer({ allowedAuthors: ['Me'] })
  assert.equal(b.add(c(1, 10, 'first')), null)
  assert.equal(b.add(c(2, 11, 'from stranger', 'created', 'eve')), null)
  assert.equal(b.add(c(3, 12, `bot reply\n${BOT_MARKER}`)), null)
  assert.equal(b.add(c(4, 10, 'first (edited)', 'edited')), null)
  assert.equal(b.add(c(5, 13, '/bot from stranger', 'created', 'eve')), null, 'non-allowlisted /bot never triggers')
  const trig = b.add(c(6, 14, '/bot go'))
  assert.deepEqual(trig, { target: 'go', author: 'me', comment_id: 14, seq: 6 })
  assert.deepEqual(b.peek(), b.peek(), 'peek does not consume')
  const items = b.drain()
  assert.deepEqual(items.map(i => [i.id, i.body]), [[10, 'first (edited)'], [14, '/bot go']])
  assert.equal(b.drain().length, 0)
  const text = formatDelivery({ repo: 'o/r', issue: 9, title: b.title, trigger: trig, items })
  assert.match(text, /o\/r#9 "T": \/bot from @me/)
  assert.match(text, /\[comment 10 · @me · edited/)
})

test('deleted comments leave the buffer', () => {
  const b = new IssueBuffer({ allowedAuthors: ['me'] })
  b.add(c(1, 10, 'oops'))
  b.add(c(2, 10, 'oops', 'deleted'))
  assert.equal(b.drain().length, 0)
})

test('formatReply: 🤖 + tag + summary line, then a Full reply toggle, then the marker', () => {
  const out = formatReply({ summary: 'Answer: <43>\n ok', body: 'Full **text**\n\nline 2', tag: 'extract · cc:c17a1e9d' })
  assert.equal(out, `🤖 extract · cc:c17a1e9d · Answer: &lt;43&gt; ok\n\n<details>\n<summary>Full reply</summary>\n\nFull **text**\n\nline 2\n\n</details>\n\n${BOT_MARKER}\n`)
  assert.ok(formatReply({ summary: 's', body: 'b' }).startsWith('🤖 s\n'), 'no tag: emoji only')
  assert.ok(out.trimEnd().endsWith(BOT_MARKER), 'marker stays last')
  assert.throws(() => formatReply({ summary: ' ', body: 'x' }), /summary/)
  assert.throws(() => formatReply({ summary: 's', body: '' }), /body/)
})

test('replyTag: name unless default, agent:id8 when known', () => {
  const agent = { agent: 'cc', id: 'c17a1e9d-0000-4000-8000-000000000000' }
  assert.equal(replyTag({ name: 'default', agent }), 'cc:c17a1e9d')
  assert.equal(replyTag({ name: 'extract', agent }), 'extract · cc:c17a1e9d')
  assert.equal(replyTag({ name: 'extract', agent: null }), 'extract')
  assert.equal(replyTag({ name: 'default', agent: null }), '')
})

test('resolveAgent: override, then the adapter\'s harness env vars, else null', () => {
  const cc = [['cc', 'CLAUDE_CODE_SESSION_ID']]
  assert.deepEqual(resolveAgent({ CLAUDE_CODE_SESSION_ID: 'abc-123' }, cc), { agent: 'cc', id: 'abc-123' })
  assert.deepEqual(resolveAgent({ ISSUECHAN_AGENT_ID: 'pi:xyz9', CLAUDE_CODE_SESSION_ID: 'abc' }, cc), { agent: 'pi', id: 'xyz9' })
  assert.deepEqual(resolveAgent({ ISSUECHAN_AGENT_ID: 'bad override', CLAUDE_CODE_SESSION_ID: 'abc' }, cc), { agent: 'cc', id: 'abc' })
  assert.equal(resolveAgent({ CLAUDE_CODE_SESSION_ID: '../etc' }, cc), null, 'ids go into file names, so reject odd chars')
  assert.equal(resolveAgent({ CLAUDE_CODE_SESSION_ID: 'abc' }), null, 'no adapter table: only the override counts')
  assert.equal(resolveAgent({}, cc), null)
})

test('C: edits never trigger, only new /bot comments do', () => {
  const b = new IssueBuffer({ allowedAuthors: ['me'] })
  assert.ok(b.add(c(1, 10, '/bot do x')))
  b.drain()
  assert.equal(b.add(c(2, 10, '/bot do y', 'edited')), null, 'edited /bot does not re-trigger')
  assert.equal(b.add(c(3, 11, 'plain → /bot later', 'edited')), null)
  const trig = b.add(c(4, 12, '/bot next'))
  assert.ok(trig)
  const items = b.drain()
  assert.deepEqual(items.map(i => [i.id, i.action]), [[10, 'edited'], [11, 'edited'], [12, 'created']])
})

test('B: edits of delivered comments carry a diff against what the agent saw', () => {
  const b = new IssueBuffer({ allowedAuthors: ['me'] })
  b.add(c(1, 10, 'value is 43\nkeep this'))
  b.add(c(2, 11, '/bot read'))
  b.drain()
  b.add(c(3, 10, 'value is 44\nkeep this', 'edited'))
  b.add(c(4, 10, 'value is 45\nkeep this', 'edited'))
  const trig = b.add(c(5, 12, '/bot again'))
  const items = b.drain()
  assert.equal(items[0].previous, 'value is 43\nkeep this', 'diff base is what the agent saw, not the intermediate edit')
  const text = formatDelivery({ repo: 'o/r', issue: 1, title: 'T', trigger: trig, items })
  assert.match(text, /```diff\n- value is 43\n\+ value is 45\n  keep this\n```/)
  // An undelivered comment edited before /bot has no diff.
  b.add(c(6, 13, 'draft'))
  b.add(c(7, 13, 'final', 'edited'))
  b.add(c(8, 14, '/bot'))
  const [first] = b.drain()
  assert.equal(first.previous, undefined)
  assert.equal(first.body, 'final')
})

test('B: deleting a delivered comment is reported; editing back to the seen text is a no-op', () => {
  const b = new IssueBuffer({ allowedAuthors: ['me'] })
  b.add(c(1, 10, 'keep'))
  b.add(c(2, 11, 'drop me'))
  b.add(c(3, 12, '/bot'))
  b.drain()
  b.add(c(4, 11, 'drop me', 'deleted'))
  b.add(c(5, 10, 'changed', 'edited'))
  b.add(c(6, 10, 'keep', 'edited'))
  const trig = b.add(c(7, 13, '/bot'))
  const items = b.drain()
  assert.deepEqual(items.map(i => [i.id, i.action]), [[11, 'deleted'], [13, 'created']])
  assert.match(formatDelivery({ repo: 'o/r', issue: 1, title: null, trigger: trig, items }), /was deleted. It said:\ndrop me/)
})

test('markDelivered seeds diff bases after a restart', () => {
  const b = new IssueBuffer({ allowedAuthors: ['me'] })
  b.markDelivered(c(1, 10, 'v1'))
  b.markDelivered(c(2, 10, 'v2', 'edited'))
  b.add(c(3, 10, 'v3', 'edited'))
  b.add(c(4, 11, '/bot'))
  assert.equal(b.drain()[0].previous, 'v2')
})

test('buffer clone is an independent rollback checkpoint, including edit-back mutation', () => {
  const b = new IssueBuffer({ allowedAuthors: ['me'] })
  b.add(c(1, 10, 'original'))
  b.drain()
  b.add(c(2, 10, 'changed', 'edited'))
  const before = b.clone()
  b.add(c(3, 10, 'original', 'edited'))
  assert.equal(b.peek().length, 0)
  assert.equal(before.peek()[0].body, 'changed')
  before.drain()
  assert.equal(b.delivered.get('comment:10'), 'original')
})

test('updates formatting has no invented /bot and replay filters bot issue bodies', () => {
  const b = new IssueBuffer({ allowedAuthors: ['me'] })
  b.markDelivered({ ...c(1, 10, `reply ${BOT_MARKER}`), event: 'issues', action: 'edited' })
  assert.equal(b.delivered.has('issue'), false)
  b.add(c(2, 11, 'ordinary'))
  const content = formatDelivery({ repo: 'me/r', issue: 1, title: null, trigger: null, items: b.peek() })
  assert.match(content, /issue update/)
  assert.doesNotMatch(content, /\/bot from/)
})

test('lineDiff', () => {
  assert.equal(lineDiff('a\nb\nc', 'a\nB\nc'), '  a\n- b\n+ B\n  c')
})

test('formatFooter: agent/model:thinking used%/window, unknown parts left out', () => {
  assert.equal(formatFooter({ agent: 'cc', model: 'claude-opus-5-5', thinking: 'medium', used: 180_000, window: 1_000_000 }), 'cc/claude-opus-5-5:medium 18%/1M')
  assert.equal(formatFooter({ agent: 'pi', model: 'gpt-x', used: 0, window: 272_000 }), 'pi/gpt-x 0%/272k')
  assert.equal(formatFooter({ agent: 'cc', model: 'm', thinking: 'high', window: 200_000 }), 'cc/m:high', 'no usage, no context part')
  assert.equal(formatFooter({ agent: 'cc', used: 1500, window: 1_500_000 }), 'cc 0%/1.5M')
  assert.equal(formatFooter({ agent: 'cc', thinking: 'high', window: 200_000 }), '', 'agent and effort alone: no footer')
  assert.equal(formatFooter({}), '')
})

test('formatReply: footer line below the toggle (GitHub) or the section (Linear), before the marker', () => {
  const gh = formatReply({ summary: 's', body: 'b', footer: 'cc/m <x> 5%/1M' })
  assert.ok(gh.endsWith(`</details>\n\n<sub>cc/m &lt;x&gt; 5%/1M</sub>\n\n${BOT_MARKER}\n`))
  assert.ok(formatReply({ summary: 's', body: 'b', footer: 'f', format: 'linear' }).endsWith('+++\n\nf\n\n[//]: # (issue-channel:bot)\n'))
  assert.equal(formatReply({ summary: 's', body: 'b', footer: ' ' }), formatReply({ summary: 's', body: 'b' }))
})
