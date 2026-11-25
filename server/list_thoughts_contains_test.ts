// All values are test-only. The database is a stubbed fetch; nothing leaves the process.
Deno.env.set('SUPABASE_URL', 'https://test.invalid');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-only');
Deno.env.set('MCP_ACCESS_KEY', 'test-only');
const { app, escapeLikePattern } = await import('./index.ts');

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function assertEquals(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  actual:   ${a}\n  expected: ${e}`);
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
  assert(!payload.error, `Protocol error: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

/** Run fn with a stubbed database; returns the PostgREST query params of each thoughts read. */
async function withFakeDatabase(rows: unknown[], fn: () => Promise<void>): Promise<URLSearchParams[]> {
  const seen: URLSearchParams[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname !== 'test.invalid' || url.pathname !== '/rest/v1/thoughts') {
      return realFetch(input, init);
    }
    const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
    if (method !== 'GET') throw new Error(`list_thoughts must be read-only, got ${method}`);
    seen.push(url.searchParams);
    return Promise.resolve(Response.json(rows));
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  return seen;
}

Deno.test('escapeLikePattern escapes LIKE metacharacters and leaves other text alone', () => {
  assertEquals(escapeLikePattern('SAM-ASSESSMENT-MARKER:'), 'SAM-ASSESSMENT-MARKER:', 'plain prefix changed');
  assertEquals(escapeLikePattern('[sam-search]'), '[sam-search]', 'bracket tag changed');
  assertEquals(escapeLikePattern('50%_off'), '50\\%\\_off', '% and _ not escaped');
  assertEquals(escapeLikePattern('a\\b'), 'a\\\\b', 'backslash not escaped');
  assertEquals(escapeLikePattern('\\%'), '\\\\\\%', 'escape order wrong');
});

Deno.test('list_thoughts schema adds optional contains and keeps existing parameters', async () => {
  const { tools } = await rpc('tools/list', 1);
  const list = tools.find((t: { name: string }) => t.name === 'list_thoughts');
  const props = list.inputSchema.properties;
  assertEquals(Object.keys(props).sort(), ['contains', 'days', 'limit', 'person', 'topic', 'type'], 'list_thoughts parameters');
  assertEquals(props.contains.type, 'string', 'contains type');
  assert(!(list.inputSchema.required ?? []).includes('contains'), 'contains must be optional');
  assertEquals(props.limit.default, 10, 'limit default changed');
  assert(props.limit.maximum === undefined || props.limit.maximum >= 100, 'limit must allow at least 100');
  assertEquals(list.annotations.readOnlyHint, true, 'list_thoughts must stay read-only');
});

Deno.test('contains sends an escaped case-insensitive ILIKE, newest first, with limit 100', async () => {
  const rows = [
    { content: 'SAM-ASSESSMENT-MARKER: 2026-11-24 newest', metadata: { type: 'observation', topics: ['sam'] }, created_at: '2026-11-24T12:00:00Z' },
    { content: 'SAM-ASSESSMENT-MARKER: 2026-11-11', metadata: { type: 'observation' }, created_at: '2026-11-11T12:00:00Z' },
  ];
  let result: { content: { text: string }[]; isError?: boolean } | undefined;
  const seen = await withFakeDatabase(rows, async () => {
    result = await rpc('tools/call', 2, { name: 'list_thoughts', arguments: { contains: 'SAM-ASSESSMENT-MARKER', limit: 100 } });
  });
  assertEquals(seen.length, 1, 'expected one database read');
  const q = seen[0];
  assertEquals(q.get('content'), 'ilike.%SAM-ASSESSMENT-MARKER%', 'ILIKE filter');
  assertEquals(q.get('order'), 'created_at.desc', 'order must be newest first');
  assertEquals(q.get('limit'), '100', 'limit 100 must pass through');
  assert(!q.has('metadata'), 'no metadata filter expected');
  assert(!result!.isError, 'tool call failed');
  assert(result!.content[0].text.startsWith('2 recent thought(s):'), 'result count');
  assert(result!.content[0].text.indexOf('newest') < result!.content[0].text.indexOf('2026-11-11'), 'result order');
});

Deno.test('contains escapes % and _ and combines with type, topic, person and days', async () => {
  const seen = await withFakeDatabase([], async () => {
    const result = await rpc('tools/call', 3, {
      name: 'list_thoughts',
      arguments: { contains: '50%_off', type: 'task', topic: 'sam', person: 'Andres', days: 7, limit: 5 },
    });
    assertEquals(result.content, [{ type: 'text', text: 'No thoughts found.' }], 'empty result text');
  });
  const q = seen[0];
  assertEquals(q.get('content'), 'ilike.%50\\%\\_off%', 'escaped ILIKE filter');
  assertEquals(q.getAll('metadata'), ['cs.{"type":"task"}', 'cs.{"topics":["sam"]}', 'cs.{"people":["Andres"]}'], 'metadata filters');
  assert(q.get('created_at')?.startsWith('gte.'), 'days filter');
  assertEquals(q.get('limit'), '5', 'limit');
});

Deno.test('without contains the query is unchanged (no content filter)', async () => {
  const seen = await withFakeDatabase([], async () => {
    await rpc('tools/call', 4, { name: 'list_thoughts', arguments: { type: 'idea' } });
    await rpc('tools/call', 5, { name: 'list_thoughts', arguments: { contains: '' } });
  });
  for (const q of seen) {
    assert(!q.has('content'), 'content filter must be absent');
    assertEquals(q.get('limit'), '10', 'default limit');
    assertEquals(q.get('order'), 'created_at.desc', 'order');
  }
});
