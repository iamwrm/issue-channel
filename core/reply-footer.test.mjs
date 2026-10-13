// Real transport-neutral engine + local fake Linear API. No live credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createIssueEngine } from './engine.mjs';
import { LINEAR_MARKER } from './lib.mjs';

test('Linear engine keeps thread routing and appends the same adapter-owned footer outside the toggle', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-footer-'));
  const creds = path.join(root, 'linear.env');
  fs.writeFileSync(creds, 'LINEAR_API_KEY=lin_api_fake\n', { mode: 0o600 });
  const calls = [];
  const api = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { query, variables } = JSON.parse(raw);
    assert.equal(req.headers.authorization, 'lin_api_fake');
    calls.push({ query, variables });
    const data = query.includes('commentCreate')
      ? { commentCreate: { success: true, comment: { id: 'fake-comment', url: 'https://linear.test/comment' } } }
      : { issue: { id: 'fake-issue' } };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data }));
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const saved = { LINEAR_API_URL: process.env.LINEAR_API_URL, ISSUECHAN_LINEAR_ENV_FILE: process.env.ISSUECHAN_LINEAR_ENV_FILE };
  process.env.LINEAR_API_URL = `http://127.0.0.1:${api.address().port}/graphql`;
  process.env.ISSUECHAN_LINEAR_ENV_FILE = creds;
  const engine = createIssueEngine({ agent: { agent: 'pi', id: 'footer-test' }, stateDir: root,
    env: { ISSUECHAN_API_KEY: 'fake', ISSUECHAN_URL: 'http://127.0.0.1:1' }, deliver: async () => {} });
  t.after(async () => {
    await engine.stop(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve));
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const result = await engine.callTool('issue_reply', { repo: 'linear:FOOTER', issue: 999,
    summary: 's', body: 'b', done: false, reply_to: 'thread-root',
    metadata: { provider: 'spoofed' } }, { replyMetadata: {
    provider: 'openai-codex', model: 'gpt-6.1-sol', thinkingLevel: 'high', contextPercent: 30, contextWindow: 1000000,
  } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.content[0].text, 'https://linear.test/comment');
  const input = calls.find(c => c.query.includes('commentCreate')).variables.input;
  assert.equal(input.parentId, 'thread-root');
  assert.equal(input.issueId, 'fake-issue');
  assert.ok(input.body.endsWith(`+++\n\nopenai-codex/gpt-6.1-sol:high 30%/1M\n\n${LINEAR_MARKER}\n`));
  assert.doesNotMatch(input.body, /spoofed/);
});
