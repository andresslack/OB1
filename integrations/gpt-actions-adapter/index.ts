import { createHandler } from './adapter.mjs';

const handler = createHandler({
  actionKey: Deno.env.get('ACTION_API_KEY'),
  upstreamKey: Deno.env.get('MCP_ACCESS_KEY'),
  upstreamUrl: Deno.env.get('OB1_MCP_URL') || 'https://ob1.andresslack.deno.net/mcp',
  publicUrl: Deno.env.get('ACTION_PUBLIC_URL'),
  citationBase: Deno.env.get('OPEN_BRAIN_CITATION_BASE_URL'),
});
Deno.serve(handler);
