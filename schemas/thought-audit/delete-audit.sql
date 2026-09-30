-- ============================================================
-- thought_audit (delete support) — Applied to production Supabase. Live table verified to match this definition on 2026-09-30.
--
-- Creates thought_audit if missing, append-only, for the server's
-- delete_thought MCP tool (source = 'mcp') and the REST DELETE
-- /thought/:id route in open-brain-rest (source = 'rest'). Same table
-- shape as schemas/thought-audit/
-- schema.sql, so running either file is safe. Idempotent.
--
-- Each writer records one row per delete BEFORE removing the thought:
--   action = 'delete'
--   diff   = { previous_content, previous_metadata, previous_created_at }
-- Restore = recapture from diff.previous_content (exact row restore,
-- including id and embedding, is not supported).
--
-- source is intentionally unconstrained (open TEXT, no CHECK), so new
-- writers can tag themselves without a schema change. For REST rows,
-- actor_context carries route, user_agent and origin. user_agent and
-- origin are client-supplied forensic hints, not identity.
--
-- No existing thoughts columns are touched. thought_id is deliberately
-- NOT a foreign key so audit rows survive deletion of their subject.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.thought_audit (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  thought_id        UUID        NOT NULL,
  action            TEXT        NOT NULL
    CHECK (action IN ('capture', 'update', 'delete')),
  source            TEXT,
  author_session_id TEXT,
  diff              JSONB,
  actor_context     JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS thought_audit_thought_id_idx
  ON public.thought_audit (thought_id);

CREATE INDEX IF NOT EXISTS thought_audit_created_at_idx
  ON public.thought_audit (created_at DESC);

ALTER TABLE public.thought_audit ENABLE ROW LEVEL SECURITY;

-- Append-only: service_role may read and insert, never modify or remove.
-- Revoke first so a broader pre-existing grant cannot linger.
REVOKE ALL ON TABLE public.thought_audit FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.thought_audit TO service_role;

-- Verify after running (expect only INSERT and SELECT for service_role):
--   SELECT grantee, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE table_schema = 'public' AND table_name = 'thought_audit'
--   ORDER BY grantee, privilege_type;
