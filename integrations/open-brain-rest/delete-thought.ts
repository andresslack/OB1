// Audit-first delete for DELETE /thought/:id. Mirrors the MCP delete_thought
// tool in server/index.ts (fetch row, write thought_audit, then delete).
// The two packages deploy separately and cannot share code, so the sequence
// is mirrored here. Kept free of side effects at import so it can be tested
// with a fake client.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DeleteOutcome =
  | { status: 200; body: { id: string; action: "deleted"; message: string; audit_id: string } }
  | { status: 400 | 404 | 500; body: { error: string } };

// Minimal structural type for the parts of the supabase client used here.
// deno-lint-ignore no-explicit-any
type Db = { from: (table: string) => any };

export async function deleteThoughtWithAudit(db: Db, id: string): Promise<DeleteOutcome> {
  if (!UUID_RE.test(id)) return { status: 400, body: { error: "Invalid thought id: must be a UUID" } };

  try {
    const { data: existing, error: fetchError } = await db
      .from("thoughts")
      .select("id, content, metadata, created_at")
      .eq("id", id)
      .maybeSingle();
    if (fetchError) return { status: 500, body: { error: fetchError.message } };
    if (!existing) return { status: 404, body: { error: "Thought not found" } };

    // Audit first. If this insert fails, the thought is NOT deleted.
    const { data: audit, error: auditError } = await db
      .from("thought_audit")
      .insert({
        thought_id: existing.id,
        action: "delete",
        source: "rest",
        diff: {
          previous_content: existing.content,
          previous_metadata: existing.metadata || {},
          previous_created_at: existing.created_at,
        },
        actor_context: { tool: "rest_delete", route: "DELETE /thought/:id" },
      })
      .select("id")
      .single();
    if (auditError || !audit) {
      return {
        status: 500,
        body: { error: `Audit write failed, nothing deleted: ${auditError?.message ?? "no audit row returned"}` },
      };
    }

    const { data: deleted, error: deleteError } = await db
      .from("thoughts")
      .delete()
      .eq("id", existing.id)
      .select("id");
    if (deleteError || !deleted || deleted.length !== 1) {
      return {
        status: 500,
        body: {
          error: `Delete failed after audit row ${audit.id} was written: ${
            deleteError?.message ?? `expected 1 deleted row, got ${deleted?.length ?? 0}`
          }`,
        },
      };
    }

    return { status: 200, body: { id: existing.id, action: "deleted", message: "Thought deleted", audit_id: audit.id } };
  } catch (error) {
    return { status: 500, body: { error: error instanceof Error ? error.message : "Delete failed" } };
  }
}
