import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replyMetadata } from './reply-metadata.ts';

test('reply metadata uses live runtime model, reasoning and context limit, not last response or totals', () => {
  let model = { provider: 'openai-codex', id: 'gpt-6.1-sol', contextWindow: 500000 };
  let thinking = 'high';
  let usage = { tokens: 300000, percent: 30, contextWindow: 1000000 };
  const pi = { getThinkingLevel: () => thinking };
  const ctx = { get model() { return model; }, getContextUsage: () => usage };
  assert.deepEqual(replyMetadata(pi, ctx), { provider: 'openai-codex', model: 'gpt-6.1-sol', thinkingLevel: 'high', contextWindow: 1000000, contextPercent: 30 });
  model = { provider: 'other', id: 'new-model', contextWindow: 272000 };
  thinking = 'off'; usage = { tokens: null, percent: null, contextWindow: 272000 };
  assert.deepEqual(replyMetadata(pi, ctx), { provider: 'other', model: 'new-model', thinkingLevel: 'off', contextWindow: 272000, contextPercent: null });
});

test('missing usage falls back to actual model limit but does not invent a percentage', () => {
  const pi = { getThinkingLevel: () => 'off' };
  assert.deepEqual(replyMetadata(pi, { model: { provider: 'p', id: 'm', contextWindow: 200000 }, getContextUsage: () => undefined }),
    { provider: 'p', model: 'm', thinkingLevel: 'off', contextWindow: 200000, contextPercent: undefined });
  assert.deepEqual(replyMetadata(pi, { model: undefined, getContextUsage: () => undefined }),
    { provider: undefined, model: undefined, thinkingLevel: 'off', contextWindow: undefined, contextPercent: undefined });
});
