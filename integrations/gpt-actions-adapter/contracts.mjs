import { z } from 'zod';

const query = z.string().trim().min(1).max(8000);
const limit = z.number().int().min(1).max(50).default(10);
const filter = z.string().trim().min(1).max(200).optional();
export const operations = {
  search: { description: 'Search OB1 memories and return identifiers and titles.', input: z.strictObject({ query }) },
  fetch: { description: 'Retrieve the full text and metadata of an OB1 thought.', input: z.strictObject({ id: z.string().trim().min(1).max(200) }) },
  search_thoughts: { description: 'Search OB1 memories by meaning.', input: z.strictObject({ query, limit, threshold: z.number().min(0).max(1).default(0.5) }) },
  list_thoughts: { description: 'List recent OB1 thoughts with optional filters.', input: z.strictObject({ limit, type: filter, topic: filter, person: filter, days: z.number().int().min(1).max(36500).optional() }) },
  thought_stats: { description: 'Get OB1 thought counts, topics, types, and people.', input: z.strictObject({}) },
  capture_thought: { description: 'Save a thought in OB1. Do not automatically retry after an error or timeout; the write may have succeeded.', input: z.strictObject({ content: z.string().trim().min(1).max(20000) }), write: true },
};

const citation = { type: 'string', format: 'uri' };
const result = { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, url: citation }, required: ['id', 'title'] };
export function openapi(publicUrl) {
  return {
    openapi: '3.1.0',
    info: { title: 'OB1 GPT Actions', version: '0.1.0', description: 'Access Open Brain memories through a REST adapter.' },
    servers: [{ url: publicUrl }],
    security: [{ actionKey: [] }],
    components: { schemas: {}, securitySchemes: { actionKey: { type: 'http', scheme: 'bearer' } } },
    paths: Object.fromEntries(Object.entries(operations).map(([name, op]) => {
      const schema = z.toJSONSchema(op.input, { io: 'input' });
      delete schema.$schema;
      const output = name === 'search' ? { type: 'object', properties: { results: { type: 'array', items: result } }, required: ['results'] }
        : name === 'fetch' ? { type: 'object', properties: { ...result.properties, text: { type: 'string' }, metadata: { type: 'object', additionalProperties: true } }, required: ['id', 'title', 'text'] }
        : { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
      return [`/actions/${name}`, { post: {
        operationId: name, description: op.description, 'x-openai-isConsequential': !!op.write,
        requestBody: { required: true, content: { 'application/json': { schema } } },
        responses: {
          200: { description: 'Successful result', content: { 'application/json': { schema: output } } },
          default: { description: 'Request, authentication, or upstream failure. Capture may have completed; do not automatically retry.', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' }, writeMayHaveSucceeded: { type: 'boolean' } }, required: ['error'] } } } },
        },
      } }];
    })),
  };
}
