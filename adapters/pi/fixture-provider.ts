// Test-only, model-free provider. Never performs network or reads real credentials.
// Uses the same stream contract as Pi's custom-provider-anthropic example.
import fs from 'node:fs';
import path from 'node:path';
import { Type } from 'typebox';
import { createAssistantMessageEventStream, getCurrentTools } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const text = (message: any) => typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');

export default function (pi: ExtensionAPI) {
  let activePreflights = 0;
  pi.on('before_agent_start', async event => {
    if (process.env.ISSUECHAN_TEST_PREFLIGHT_GATE !== '1' || !event.prompt.startsWith('[issue-channel delivery=')) return;
    const control = process.env.ISSUECHAN_TEST_CONTROL!;
    const trace = path.join(control, 'preflight.jsonl');
    const record = (phase: string) => fs.appendFileSync(trace, JSON.stringify({ phase, active: activePreflights, prompt: event.prompt }) + '\n');
    activePreflights++;
    record('start');
    try {
      const deadline = Date.now() + 8000;
      while (!fs.existsSync(path.join(control, 'preflight-release'))) {
        if (Date.now() > deadline) throw new Error('Test preflight gate timed out');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } finally { activePreflights--; record('end'); }
  });
  let activeInputs = 0;
  pi.on('input', async event => {
    if (process.env.ISSUECHAN_TEST_INPUT_GATE !== '1' || !event.text.startsWith('[issue-channel delivery=')) return;
    const control = process.env.ISSUECHAN_TEST_CONTROL!;
    const trace = path.join(control, 'input-preflight.jsonl');
    const record = (phase: string) => fs.appendFileSync(trace, JSON.stringify({ phase, active: activeInputs, prompt: event.text }) + '\n');
    activeInputs++;
    record('start');
    try {
      const deadline = Date.now() + 8000;
      while (!fs.existsSync(path.join(control, 'input-preflight-release'))) {
        if (Date.now() > deadline) throw new Error('Test input gate timed out');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } finally { activeInputs--; record('end'); }
  });
  pi.registerCommand('test-reload', { description: 'Test-only reload', handler: async (_, ctx) => { await ctx.reload(); } });
  pi.registerCommand('test-shutdown', { description: 'Test-only shutdown', handler: async (_, ctx) => { ctx.shutdown(); } });
  pi.registerCommand('test-theme', { description: 'Test-only native theme switch', handler: async (name, ctx) => {
    if (name !== 'light' && name !== 'dark') throw new Error('Expected light or dark');
    const result = ctx.ui.setTheme(name);
    if (!result.success) throw new Error(result.error ?? 'Theme switch failed');
    fs.writeFileSync(path.join(process.env.ISSUECHAN_TEST_CONTROL!, 'theme-applied'), name);
  } });
  pi.registerTool({
    name: 'test_gate', label: 'Test gate', description: 'Wait for the test harness to release a tool boundary',
    parameters: Type.Object({}),
    async execute(_id, _args, signal) {
      const dir = process.env.ISSUECHAN_TEST_CONTROL!;
      fs.writeFileSync(path.join(dir, 'gate-started'), 'started');
      const deadline = Date.now() + 8000;
      while (!fs.existsSync(path.join(dir, 'gate-release'))) {
        if (signal?.aborted) throw new Error('Test gate aborted');
        if (Date.now() > deadline) throw new Error('Test gate timed out');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return { content: [{ type: 'text', text: 'GATE_RELEASED' }], details: undefined };
    },
  });
  let serial = 0;
  pi.registerProvider('issuechan-test', {
    api: 'issuechan-test-api', apiKey: 'test-only-not-a-secret', baseUrl: 'http://127.0.0.1:1',
    models: [{ id: 'deterministic', name: 'Issue-channel test', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1024 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message: any = {
        role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: 'pending',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(async () => {
        try {
          const snapshot = { messages: context.messages, tools: getCurrentTools(context.messages) };
          // These are actual Pi provider inputs, not synthesized transcript fixtures.
          fs.appendFileSync(process.env.ISSUECHAN_TEST_SNAPSHOTS!, JSON.stringify(snapshot) + '\n');
          await options?.onPayload?.(snapshot, model);
          await options?.onResponse?.({ status: 200, headers: {} }, model);
          if (options?.signal?.aborted) throw new Error('Test provider aborted');
          stream.push({ type: 'start', partial: message });
          const last = context.messages.filter((m: any) => m.role !== 'system').at(-1);
          const user = context.messages.filter((m: any) => m.role === 'user').at(-1);
          const prompt = text(user);
          const tool = last?.role === 'user' && prompt.startsWith('TEST_TOOL ') ? JSON.parse(prompt.slice(10))
            : last?.role === 'user' && prompt === 'TEST_BUSY' ? { name: 'test_gate', arguments: {} } : null;
          if (tool) {
            const block: any = { type: 'toolCall', id: `test-${++serial}`, name: tool.name, arguments: {} };
            message.content.push(block);
            stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
            block.arguments = tool.arguments;
            stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(tool.arguments), partial: message });
            stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: block, partial: message });
            message.stopReason = 'toolUse';
          } else {
            const response = prompt.includes('[issue-channel delivery=') ? 'DELIVERY_OBSERVED'
              : prompt === 'TEST_BUSY' ? 'BASELINE_COMPLETED_WITHOUT_STEER' : 'TEST_OK';
            const block = { type: 'text' as const, text: '' };
            message.content.push(block);
            stream.push({ type: 'text_start', contentIndex: 0, partial: message });
            block.text = response;
            stream.push({ type: 'text_delta', contentIndex: 0, delta: response, partial: message });
            stream.push({ type: 'text_end', contentIndex: 0, content: response, partial: message });
            message.stopReason = 'stop';
          }
          stream.push({ type: 'done', reason: message.stopReason, message });
        } catch (error) {
          message.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
          message.errorMessage = String(error);
          stream.push({ type: 'error', reason: message.stopReason, error: message });
        } finally { stream.end(); }
      });
      return stream;
    },
  });
}
