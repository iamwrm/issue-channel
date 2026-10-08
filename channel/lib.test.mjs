import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTrigger, isForSession, IssueBuffer, formatDelivery, BOT_MARKER } from './lib.mjs'

test('parseTrigger', () => {
  assert.deepEqual(parseTrigger('/bot'), { target: null })
  assert.deepEqual(parseTrigger('  /bot review\nplease look'), { target: 'review' })
  assert.deepEqual(parseTrigger('/bot please fix it'), { target: null })
  assert.equal(parseTrigger('/botany'), null)
  assert.equal(parseTrigger('hello /bot'), null)
  assert.equal(parseTrigger(null), null)
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
