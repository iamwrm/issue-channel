import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { contextWindow, footerStats } from './footer.mjs'

const ID = '0f0e0d0c-1111-2222-3333-444455556666'
const line = (o) => JSON.stringify(o) + '\n'
const turn = (model, usage, extra = {}) => line({ type: 'assistant', message: { model, usage }, ...extra })

test('footerStats: last main-thread turn from the transcript, effort from settings, window from the model', t => {
  // Next to the test, not in os.tmpdir(): /tmp may be noexec and this keeps fixtures with the code.
  const home = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '.footer-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const dir = path.join(home, '.claude'), proj = path.join(dir, 'projects', '-work')
  fs.mkdirSync(proj, { recursive: true })
  fs.writeFileSync(path.join(proj, `${ID}.jsonl`), [
    turn('claude-opus-5-5', { input_tokens: 9, cache_read_input_tokens: 9, cache_creation_input_tokens: 9 }),
    turn('claude-opus-5-5', { input_tokens: 2, cache_read_input_tokens: 170_000, cache_creation_input_tokens: 9_998 }),
    turn('claude-haiku-5-5', { input_tokens: 1 }, { isSidechain: true }),
    turn('<synthetic>', { input_tokens: 0 }),
    line({ type: 'user', message: { content: 'hi' } }),
    '{"truncated',
  ].join(''))
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ effortLevel: 'low', modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium' } } }))
  const env = {}
  assert.deepEqual(footerStats(ID, { env, home }), { model: 'claude-opus-5-5', thinking: 'medium', used: 180_000, window: 1_000_000 })
  assert.deepEqual(footerStats(ID, { env: { CLAUDE_EFFORT: 'max', ISSUECHAN_CONTEXT_WINDOW: '400000' }, home }),
    { model: 'claude-opus-5-5', thinking: 'max', used: 180_000, window: 400_000 })
  assert.deepEqual(footerStats('ffffffff-0000-0000-0000-000000000000', { env, home }), { model: undefined, thinking: 'low', used: undefined, window: undefined })
  assert.deepEqual(footerStats(undefined, { env, home }), {})
})

test('contextWindow', () => {
  assert.equal(contextWindow('claude-opus-5-5'), 1_000_000)
  assert.equal(contextWindow('claude-fable-5-1'), 1_000_000)
  assert.equal(contextWindow('claude-haiku-5-5'), 200_000)
  assert.equal(contextWindow('claude-haiku-4-5[1m]'), 1_000_000)
  assert.equal(contextWindow('gpt-x'), undefined)
  assert.equal(contextWindow(undefined), undefined)
})
