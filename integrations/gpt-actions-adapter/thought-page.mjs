const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const escape = text => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function page(text, status) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>Thought</title><style>body{margin:0;background:#faf9f6;color:#242424;font:18px/1.65 system-ui,sans-serif}main{max-width:740px;margin:48px auto;padding:0 24px;white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><main>${escape(text)}</main></body></html>`, { status, headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, max-age=0, must-revalidate',
    'Pragma': 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  } });
}
export async function thoughtPage(request, config, invoke) {
  const url = new URL(request.url);
  const id = url.pathname.slice('/thoughts/'.length);
  if (request.method !== 'GET' || url.search || !url.pathname.startsWith('/thoughts/') || !UUID.test(id)) return page('Not found.', 404);
  try {
    // Reuse OB1 fetch's Supabase .eq('id', id).single() lookup, never a list.
    const result = await invoke(config, 'fetch', { id }, AbortSignal.any([request.signal, AbortSignal.timeout(config.timeoutMs ?? 35000)]));
    if (result?.isError || !Array.isArray(result?.content) || result.content.some(x => x.type !== 'text')) return page('Not found.', 404);
    const thought = JSON.parse(result.content.map(x => x.text).join('\n'));
    if (thought.id?.toLowerCase() !== id.toLowerCase() || typeof thought.text !== 'string') return page('Not found.', 404);
    // Do not render title, metadata, IDs, URLs, or any other returned fields.
    return page(thought.text, 200);
  } catch { return page('Not found.', 404); }
}
