// All values are test-only. Tests exercise discovery/protocol handling and never call a database.
Deno.env.set('SUPABASE_URL', 'https://test.invalid');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-only');
Deno.env.set('MCP_ACCESS_KEY', 'test-only');
const { app } = await import('./index.ts');

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function rpc(method: string, id: number, params?: unknown) {
  const response = await app.request('https://test.invalid/mcp', {
    method: 'POST',
    headers: { 'x-brain-key': 'test-only', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', method, id, ...(params ? { params } : {}) }),
  });
  const text = await response.text();
  assert(response.status === 200, `HTTP ${response.status}: ${text}`);
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(text.split('\n').find(line => line.startsWith('data:'))!.slice(5))
    : JSON.parse(text);
  assert(payload.id === id, 'Response correlation must be preserved');
  assert(!payload.error, `Protocol error: ${JSON.stringify(payload.error)}`);
  return payload.result;
}
Deno.test('sequential initialization and repeated tool discovery on one app instance', async () => {
  await rpc('initialize', 1, { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  for (let i = 2; i < 12; i++) {
    const result = await rpc('tools/list', i);
    assert(result.tools.length === 6, 'All six tool schemas must remain available');
  }
});
Deno.test('concurrent requests have independent connections and response IDs', async () => {
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => rpc('tools/list', 100 + i)));
  assert(results.every(result => result.tools.length === 6), 'Concurrent discovery must succeed');
});
Deno.test('discovery and auth behavior stay compatible', async () => {
  const response = await app.request('https://test.invalid/mcp', { headers: { 'x-brain-key': 'test-only' } });
  assert((await response.json()).tools.length === 6, 'GET discovery changed');
  const bad = await app.request('https://test.invalid/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }) });
  const error = await bad.json();
  assert(bad.status === 200 && error.error.code === -32001 && error.id === 99, 'Auth behavior changed');
});
