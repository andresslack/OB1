import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { writeFileSync } from 'node:fs';

const url = new URL(process.env.OB1_PREVIEW_URL);
if (url.protocol !== 'https:' || url.hostname !== 'ob1.andresslack.deno.net') throw new Error('An immutable OB1 preview URL is required. Production is prohibited.');
url.pathname = '/mcp';
url.search = '';
if (process.env.OB1_ENV_FILE) process.loadEnvFile(process.env.OB1_ENV_FILE);
const key = process.env.MCP_ACCESS_KEY;
if (!key) throw new Error('MCP_ACCESS_KEY is required.');
const report = { preview: url.origin, started: new Date().toISOString(), tests: [], captures: 0 };
const expected = ['capture_thought', 'fetch', 'list_thoughts', 'search', 'search_thoughts', 'thought_stats'];
function assert(condition, message) { if (!condition) throw new Error(message); }
async function test(name, fn) {
  const start = Date.now();
  try { await fn(); report.tests.push({ name, passed: true, ms: Date.now() - start }); console.log(`PASS ${name}`); }
  catch (error) { report.tests.push({ name, passed: false, ms: Date.now() - start, error: error.name }); console.log(`FAIL ${name}: ${error.name}`); process.exitCode = 1; }
}
async function connected(fn) {
  const client = new Client({ name: 'ob1-preview-reconnect-check', version: '1.0.0' });
  const deadline = AbortSignal.timeout(25000);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { 'x-brain-key': key } },
    fetch: (address, init) => fetch(address, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline }),
  });
  client.onerror = () => {};
  try { await client.connect(transport); await fn(client); }
  finally { await client.close(); }
}
async function list(client) {
  const tools = (await client.listTools()).tools;
  assert(JSON.stringify(tools.map(tool => tool.name).sort()) === JSON.stringify(expected), 'Tool inventory differs');
}
await test('one client: initialize + 20 sequential discovery/ping pairs', () => connected(async client => {
  for (let i = 0; i < 20; i++) { await list(client); await client.ping(); }
}));
await test('five disconnect/reconnect cycles with repeated discovery and a real read', async () => {
  for (let cycle = 0; cycle < 5; cycle++) await connected(async client => {
    for (let i = 0; i < 4; i++) await list(client);
    const result = await client.callTool({ name: 'list_thoughts', arguments: { limit: 1 } });
    assert(!result.isError, 'Read failed');
    await client.ping();
  });
});
await test('four concurrent clients, five discovery/ping pairs each', () => Promise.all(Array.from({ length: 4 }, () => connected(async client => {
  for (let i = 0; i < 5; i++) { await list(client); await client.ping(); }
}))));
await test('ten direct stateless requests for legacy HTTP clients', async () => {
  for (let i = 0; i < 10; i++) {
    const response = await fetch(url, { method: 'POST', headers: { 'x-brain-key': key, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/list' }), signal: AbortSignal.timeout(10000) });
    assert(response.ok, 'HTTP failure');
    const text = await response.text();
    const message = response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(text.split('\n').find(line => line.startsWith('data:')).slice(5)) : JSON.parse(text);
    assert(message.id === i && message.result?.tools?.length === 6, 'Invalid response');
  }
});
await test('invalid credential followed by a valid new connection', async () => {
  const response = await fetch(url, { method: 'POST', headers: { 'x-brain-key': 'intentional-invalid-test-key', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }), signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  assert(result.error?.code === -32001, 'Expected authentication failure');
  await connected(list);
});
report.finished = new Date().toISOString();
writeFileSync(process.env.OB1_TEST_REPORT || 'preview-results.json', JSON.stringify(report, null, 2) + '\n');
