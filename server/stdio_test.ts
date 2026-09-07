import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

Deno.test('actual stdio child initializes, discovers, calls and stays connected', async () => {
  let databaseReads = 0;
  const database = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, request => {
    if (new URL(request.url).pathname !== '/rest/v1/thoughts') return new Response('unexpected path', { status: 404 });
    databaseReads++;
    return Response.json([]);
  });
  const transport = new StdioClientTransport({
    command: Deno.execPath(),
    args: ['run', '--cached-only', '--allow-env', '--allow-net=127.0.0.1', new URL('./index.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
    cwd: new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    env: {
      DENO_DIR: Deno.env.get('DENO_DIR')!,
      PORT: '', DENO_DEPLOYMENT_ID: '',
      SUPABASE_URL: `http://127.0.0.1:${database.addr.port}`,
      SUPABASE_SERVICE_ROLE_KEY: 'test-only', MCP_ACCESS_KEY: 'test-only',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-regression', version: '1.0.0' });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((tool: { name: string }) => tool.name).sort();
    const expected = ['capture_thought', 'fetch', 'list_thoughts', 'search', 'search_thoughts', 'thought_stats'];
    if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error('Stdio tool schemas changed');
    for (let i = 0; i < 3; i++) {
      const result = await client.callTool({ name: 'list_thoughts', arguments: { limit: 1 } });
      if (result.isError || JSON.stringify(result.content) !== JSON.stringify([{ type: 'text', text: 'No thoughts found.' }])) throw new Error('Stdio tool call failed');
      await client.ping();
    }
    if (databaseReads !== 3) throw new Error('Expected three real tool dispatches to the local fake database');
    if ((await client.listTools()).tools.length !== 6) throw new Error('Stdio connection did not survive tool calls');
  } finally {
    await client.close();
    await database.shutdown();
  }
});
