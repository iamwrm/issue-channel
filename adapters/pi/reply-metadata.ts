import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ReplyMetadata } from '../../core/engine.mjs';

// Snapshot the current tool context, not the launch/session-start context. Model
// switches, resume and compaction must be reflected in the next posted reply.
export function replyMetadata(pi: Pick<ExtensionAPI, 'getThinkingLevel'>,
  ctx: Pick<ExtensionContext, 'model' | 'getContextUsage'>): ReplyMetadata {
  const usage = ctx.getContextUsage();
  return {
    provider: ctx.model?.provider,
    model: ctx.model?.id,
    thinkingLevel: pi.getThinkingLevel(),
    contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow,
    contextPercent: usage?.percent,
  };
}
