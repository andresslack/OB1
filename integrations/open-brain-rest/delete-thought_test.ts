// All values are test-only fakes. No network or database is touched.
import { deleteThoughtWithAudit } from "./delete-thought.ts";

const ID = "11111111-2222-4333-8444-555555555555";
const AUDIT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function assertEq(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

type Opts = { row?: unknown; auditError?: string; deleteRows?: unknown[] };

// Fake client that records the order of operations.
function fakeDb(opts: Opts) {
  const calls: string[] = [];
  let auditPayload: Record<string, unknown> | null = null;
  const db = {
    from(table: string) {
      const ctx: { op: string } = { op: "select" };
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => {
          calls.push(`${table}.select`);
          return Promise.resolve({ data: "row" in opts ? opts.row : { id: ID, content: "fake content", metadata: { k: 1 }, created_at: "2026-01-01T00:00:00Z" }, error: null });
        },
        insert: (payload: Record<string, unknown>) => {
          ctx.op = "insert";
          auditPayload = payload;
          return chain;
        },
        single: () => {
          calls.push(`${table}.insert`);
          return Promise.resolve(opts.auditError
            ? { data: null, error: { message: opts.auditError } }
            : { data: { id: AUDIT_ID }, error: null });
        },
        delete: () => {
          ctx.op = "delete";
          return {
            eq: () => ({
              select: () => {
                calls.push(`${table}.delete`);
                return Promise.resolve({ data: opts.deleteRows ?? [{ id: ID }], error: null });
              },
            }),
          };
        },
      };
      return chain;
    },
  };
  return { db, calls, audit: () => auditPayload };
}

Deno.test("invalid UUID gives 400 and touches nothing", async () => {
  for (const bad of ["not-a-uuid", "123", "' or 1=1 --", ""]) {
    const f = fakeDb({});
    const r = await deleteThoughtWithAudit(f.db, bad);
    assertEq(r.status, 400, `status for ${JSON.stringify(bad)}`);
    assertEq(f.calls, [], "no db calls on invalid id");
  }
});

Deno.test("unknown UUID gives 404, no audit row, no delete", async () => {
  const f = fakeDb({ row: null });
  const r = await deleteThoughtWithAudit(f.db, ID);
  assertEq(r.status, 404, "status");
  assertEq(r.body, { error: "Thought not found" }, "body");
  assertEq(f.calls, ["thoughts.select"], "only the lookup ran");
});

Deno.test("audit insert failure gives 500 and deletes nothing", async () => {
  const f = fakeDb({ auditError: "forced failure" });
  const r = await deleteThoughtWithAudit(f.db, ID);
  assertEq(r.status, 500, "status");
  assertEq(f.calls, ["thoughts.select", "thought_audit.insert"], "no delete after failed audit");
});

Deno.test("success writes audit row before delete and returns audit_id", async () => {
  const f = fakeDb({});
  const r = await deleteThoughtWithAudit(f.db, ID);
  assertEq(r.status, 200, "status");
  assertEq(r.body, { id: ID, action: "deleted", message: "Thought deleted", audit_id: AUDIT_ID }, "body");
  assertEq(f.calls, ["thoughts.select", "thought_audit.insert", "thoughts.delete"], "audit precedes delete");
  assertEq(f.audit(), {
    thought_id: ID,
    action: "delete",
    source: "rest",
    diff: { previous_content: "fake content", previous_metadata: { k: 1 }, previous_created_at: "2026-01-01T00:00:00Z" },
    actor_context: { tool: "rest_delete", route: "DELETE /thought/:id" },
  }, "audit payload");
});

Deno.test("delete that removes no row after audit gives 500", async () => {
  const f = fakeDb({ deleteRows: [] });
  const r = await deleteThoughtWithAudit(f.db, ID);
  assertEq(r.status, 500, "status");
});
