import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createHandler, callMcp } from './adapter.mjs';
import { openapi } from './contracts.mjs';

const config = { actionKey: 'a'.repeat(40), upstreamKey: 'upstream-secret', upstreamUrl: 'https://ob1.example/mcp', publicUrl: 'https://actions.example' };
const req = (name, body = {}, key = config.actionKey) => new Request(`https://actions.example/actions/${name}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const content = text => ({ content: [{ type: 'text', text }] });

test('unauthorized and invalid requests never reach OB1', async () => {
  let calls = 0;
  const handler = createHandler(config, async () => { calls++; return content('ok'); });
  assert.equal((await handler(req('thought_stats', {}, 'wrong'))).status, 401);
  for (const args of [{ query: '' }, { query: 'ok', limit: 100000 }, { query: 'ok', threshold: 2 }, { query: 'ok', extra: true }]) assert.equal((await handler(req('search_thoughts', args))).status, 400);
  assert.equal((await handler(req('capture_thought', { content: 'x'.repeat(91000) }))).status, 413);
  assert.equal(calls, 0);
});
test('all seven operations dispatch correct names, arguments and defaults', async () => {
  const seen = [];
  const handler = createHandler(config, async (_, name, args) => {
    seen.push([name, args]);
    return content(name === 'search' ? '{"results":[]}' : name === 'fetch' ? '{"id":"one","title":"One","text":"Body"}' : name === 'delete_thought' ? '{"deleted_id":"11111111-1111-4111-8111-111111111111","audit_id":"22222222-2222-4222-8222-222222222222"}' : 'ok');
  });
  for (const [name, args] of [['search', { query: 'hi' }], ['fetch', { id: 'one' }], ['search_thoughts', { query: 'hi' }], ['list_thoughts', { topic: 'work' }], ['thought_stats', {}], ['capture_thought', { content: 'note' }], ['delete_thought', { id: '11111111-1111-4111-8111-111111111111' }]]) assert.equal((await handler(req(name, args))).status, 200);
  assert.deepEqual(seen[2], ['search_thoughts', { query: 'hi', limit: 10, threshold: 0.5 }]);
  assert.deepEqual(seen[3], ['list_thoughts', { limit: 10, topic: 'work' }]);
  assert.equal(seen.length, 7);
});
test('citations omitted unless verified base configured; text remains available', async () => {
  const invoke = async () => content(JSON.stringify({ id: 'a/b', title: 'Title', text: 'Full text', url: 'https://openbrain.local/thoughts/a' }));
  const plain = await (await createHandler(config, invoke)(req('fetch', { id: 'a/b' }))).json();
  assert.equal(plain.url, undefined);
  assert.equal(plain.text, 'Full text');
  const linked = await (await createHandler({ ...config, citationBase: 'https://dashboard.example/thoughts' }, invoke)(req('fetch', { id: 'a/b' }))).json();
  assert.equal(linked.url, 'https://dashboard.example/thoughts/a%2Fb');
});
test('tool errors and thrown secrets are sanitized; capture never retried', async () => {
  let calls = 0;
  const handler = createHandler(config, async () => { calls++; throw new Error(config.upstreamKey); });
  const response = await handler(req('capture_thought', { content: 'note' }));
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'OB1 request failed.', writeMayHaveSucceeded: true });
  assert.equal(calls, 1);
  assert.equal((await createHandler(config, async () => ({ ...content('secret'), isError: true }))(req('thought_stats'))).status, 502);
});
test('timeout returns 504 and warns about uncertain capture', async () => {
  const handler = createHandler({ ...config, timeoutMs: 20 }, async (_, name, args, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 500);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  }));
  const response = await handler(req('capture_thought', { content: 'note' }));
  assert.equal(response.status, 504);
  assert.equal((await response.json()).writeMayHaveSucceeded, true);
});
test('oversized and malformed upstream results fail cleanly', async () => {
  assert.equal((await createHandler(config, async () => content('x'.repeat(90001)))(req('thought_stats'))).status, 502);
  assert.equal((await createHandler(config, async () => content('{}'))(req('search', { query: 'hi' }))).status, 502);
});
test('schema has seven explicit operations and both writes require confirmation', () => {
  const schema = openapi(config.publicUrl);
  assert.equal(Object.keys(schema.paths).length, 7);
  for (const [path, item] of Object.entries(schema.paths)) assert.equal(item.post['x-openai-isConsequential'], path.endsWith('capture_thought') || path.endsWith('delete_thought'));
  assert.equal(schema.components.securitySchemes.actionKey.scheme, 'bearer');
});
test('reproduces the inspected OB1 shared-server transport lifecycle error', async () => {
  const server = new McpServer({ name: 'shared-ob1', version: '1.0.0' });
  const first = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const second = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(first);
    await assert.rejects(server.connect(second), /Already connected to a transport/);
  } finally { await server.close(); await second.close(); }
});
test('SDK transport calls stateless OB1 directly and reads SSE and JSON responses', async () => {
  for (const enableJsonResponse of [false, true]) {
    let calls = 0;
    const http = createServer(async (request, response) => {
      assert.equal(request.headers['x-brain-key'], config.upstreamKey);
      const server = new McpServer({ name: 'test-ob1', version: '1.0.0' });
      server.registerTool('search', { inputSchema: { query: z.string() } }, async ({ query }) => { calls++; return content(JSON.stringify({ results: [{ id: 'one', title: query }] })); });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse });
      response.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(request, response);
    });
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    try {
      const result = await callMcp({ ...config, upstreamUrl: `http://127.0.0.1:${http.address().port}/mcp` }, 'search', { query: 'hello' }, AbortSignal.timeout(5000));
      assert.equal(JSON.parse(result.content[0].text).results[0].title, 'hello');
      assert.equal(calls, 1);
    } finally { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }
  }
});
