import { randomBytes } from 'node:crypto';
import { createHandler } from './adapter.mjs';

// Optional local env file is read into memory; no values or memory contents are logged.
if (process.env.OB1_ENV_FILE) process.loadEnvFile(process.env.OB1_ENV_FILE);
const config = {
  actionKey: randomBytes(32).toString('hex'),
  upstreamKey: process.env.MCP_ACCESS_KEY,
  upstreamUrl: process.env.OB1_MCP_URL || 'https://ob1.andresslack.deno.net/mcp',
  publicUrl: 'https://smoke.example',
};
const handler = createHandler(config);
async function read(name, args) {
  const response = await handler(new Request(`https://smoke.example/actions/${name}`, {
    method: 'POST', headers: { authorization: `Bearer ${config.actionKey}`, 'content-type': 'application/json' }, body: JSON.stringify(args),
  }));
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const result = await response.json();
  console.log(`${name}: PASS`);
  return result;
}
let searchResult;
for (const [name, args] of [['thought_stats', {}], ['list_thoughts', { limit: 1 }], ['search_thoughts', { query: 'OB1 ChatGPT connection', limit: 1 }], ['search', { query: 'OB1 ChatGPT connection' }]]) {
  try { const result = await read(name, args); if (name === 'search') searchResult = result; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
if (searchResult?.results.length) {
  try { await read('fetch', { id: searchResult.results[0].id }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
} else console.log('fetch: SKIPPED (no search ID available)');
