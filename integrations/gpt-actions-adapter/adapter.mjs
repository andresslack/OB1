import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { operations, openapi } from './contracts.mjs';
import { thoughtPage } from './thought-page.mjs';

const MAX_BYTES = 90000;
export class AdapterError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function httpsUrl(value, label) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error(`${label} must be an HTTPS URL without credentials, query, or fragment`);
  return url;
}
function json(data, status = 200) {
  const text = JSON.stringify(data);
  if (new TextEncoder().encode(text).length >= MAX_BYTES) throw new AdapterError(502, 'OB1 response is too large. Narrow the request.');
  return new Response(text, { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}) } });
}
async function boundedBody(request) {
  if (!request.body) throw new AdapterError(400, 'A JSON object is required.');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size >= MAX_BYTES) throw new AdapterError(413, 'Request is too large.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new AdapterError(400, 'Invalid JSON.'); }
}

export async function callMcp(config, name, args, signal) {
  const transport = new StreamableHTTPClientTransport(new URL(config.upstreamUrl), {
    requestInit: { headers: { 'x-brain-key': config.upstreamKey } },
    fetch: async (url, init) => {
      const response = await fetch(url, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal });
      if (response.status === 401 || response.status === 403) throw new AdapterError(502, 'OB1 authentication failed. Check adapter configuration.');
      return response;
    },
  });
  // OB1 HTTP is stateless. Use direct tools/call through the SDK transport.
  // Verified against repaired production 91153c3; no retries or sessions.
  const id = crypto.randomUUID();
  let abort;
  try {
    await transport.start();
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      transport.onerror = reject;
      transport.onmessage = message => {
        if (message.id !== id) return;
        if (message.error) {
          const code = message.error.code;
          reject(new AdapterError(code === -32602 ? 400 : 502,
            code === -32001 ? 'OB1 authentication failed. Check adapter configuration.' : 'OB1 rejected the operation.'));
        } else if ('result' in message) resolve(message.result);
      };
      transport.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }).catch(reject);
    });
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
    await transport.close().catch(() => {});
  }
}

function normalize(name, result, citationBase) {
  if (result?.isError) throw new AdapterError(502, 'OB1 could not complete this operation.');
  if (!Array.isArray(result?.content) || result.content.some(c => c.type !== 'text' || typeof c.text !== 'string')) throw new AdapterError(502, 'Unexpected OB1 response.');
  const text = result.content.map(c => c.text).join('\n');
  if (name !== 'search' && name !== 'fetch') return { text };
  let data;
  try { data = JSON.parse(text); } catch { throw new AdapterError(502, 'Invalid structured OB1 result.'); }
  function document(item, full = false) {
    if (!item || typeof item.id !== 'string' || typeof item.title !== 'string' || (full && typeof item.text !== 'string')) throw new AdapterError(502, 'Invalid OB1 document.');
    const output = { id: item.id, title: item.title };
    // Only publish URLs from the explicitly configured, verified detail view.
    if (citationBase) output.url = `${citationBase.replace(/\/$/, '')}/${encodeURIComponent(item.id)}`;
    if (full) {
      output.text = item.text;
      if (item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)) output.metadata = item.metadata;
    }
    return output;
  }
  if (name === 'fetch') return document(data, true);
  if (!Array.isArray(data?.results)) throw new AdapterError(502, 'Invalid OB1 search results.');
  return { results: data.results.map(item => document(item)) };
}

export function createHandler(config, invoke = callMcp) {
  if (!config.actionKey || config.actionKey.length < 32 || !config.upstreamKey || config.actionKey === config.upstreamKey) throw new Error('Configure a separate ACTION_API_KEY of at least 32 characters and MCP_ACCESS_KEY.');
  httpsUrl(config.upstreamUrl, 'OB1_MCP_URL');
  httpsUrl(config.publicUrl, 'ACTION_PUBLIC_URL');
  if (config.citationBase) httpsUrl(config.citationBase, 'OPEN_BRAIN_CITATION_BASE_URL');
  const expected = new TextEncoder().encode(`Bearer ${config.actionKey}`);
  return async request => {
    let writeStarted = false;
    try {
      const path = new URL(request.url).pathname;
      if (path === '/thoughts' || path.startsWith('/thoughts/')) return thoughtPage(request, config, invoke);
      if (request.method === 'GET' && path === '/health') return json({ ok: true, service: 'ob1-gpt-actions', version: '0.1.0' });
      if (request.method === 'GET' && path === '/openapi.json') return json(openapi(config.publicUrl));
      const supplied = new TextEncoder().encode(request.headers.get('authorization') || '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json({ error: 'Unauthorized.' }, 401);
      const name = path.startsWith('/actions/') ? path.slice(9) : '';
      if (!Object.hasOwn(operations, name)) return json({ error: 'Unknown operation.' }, 404);
      if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
      if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return json({ error: 'Use application/json.' }, 415);
      const parsed = operations[name].input.safeParse(await boundedBody(request));
      if (!parsed.success) return json({ error: 'Invalid arguments. Check the operation schema.' }, 400);
      writeStarted = !!operations[name].write;
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(config.timeoutMs ?? 35000)]);
      let result;
      try { result = await invoke(config, name, parsed.data, signal); }
      catch (error) {
        if (signal.aborted) throw new AdapterError(504, 'OB1 request timed out or was cancelled.');
        throw error;
      }
      return json(normalize(name, result, config.citationBase));
    } catch (error) {
      return json({ error: error instanceof AdapterError ? error.message : 'OB1 request failed.', ...(writeStarted ? { writeMayHaveSucceeded: true } : {}) }, error instanceof AdapterError ? error.status : 502);
    }
  };
}
