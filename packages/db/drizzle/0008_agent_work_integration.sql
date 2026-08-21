-- Reviewed legacy compatibility authority. This is deliberately restricted to
-- assignments created by the pre-canonical 0003 backfill: Mastra + automatic +
-- revision 1. It never creates authority for external Managers. The deterministic
-- id and fixed approval marker make the provenance auditable and retry-safe.
INSERT INTO app.agent_capability_grants
  (id,user_id,account_id,manager_kind,agent_connection_id,capabilities,invocation_modes,
   state,revision,approved_at,created_at,updated_at)
SELECT (substr(md5('legacy-mastra-grant:'||a.user_id::text||':'||a.account_id::text),1,8)||'-'||
        substr(md5('legacy-mastra-grant:'||a.user_id::text||':'||a.account_id::text),9,4)||'-5'||
        substr(md5('legacy-mastra-grant:'||a.user_id::text||':'||a.account_id::text),14,3)||'-8'||
        substr(md5('legacy-mastra-grant:'||a.user_id::text||':'||a.account_id::text),18,3)||'-'||
        substr(md5('legacy-mastra-grant:'||a.user_id::text||':'||a.account_id::text),21,12))::uuid,
       a.user_id,a.account_id,'mastra',null,
       ARRAY['mail.read','mail.archive','mail.trash_recoverable','mail.move','mail.mark_read',
             'mail.mark_unread','draft.create','draft.edit']::text[],
       ARRAY['automatic']::text[],'active',1,'2026-08-16T00:00:00Z'::timestamptz,
       '2026-08-16T00:00:00Z'::timestamptz,'2026-08-16T00:00:00Z'::timestamptz
FROM app.mailbox_manager_assignments a
WHERE a.manager_kind='mastra' AND a.agent_connection_id IS NULL
  AND a.automatic_processing_enabled AND a.revision=1
ON CONFLICT(user_id,account_id) DO NOTHING;

-- Phase B bridge between the legacy delivery job and its canonical immutable Run.
-- Nullable by design: external/none Managers and unavailable authority remain pending
-- legacy jobs and are never handed to embedded Mastra.
ALTER TABLE app.agent_jobs
  ADD COLUMN agent_run_id uuid,
  ADD COLUMN unavailable_reason text;
ALTER TABLE app.agent_jobs
  ADD CONSTRAINT agent_jobs_agent_run_fk FOREIGN KEY (agent_run_id)
    REFERENCES app.agent_runs(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX agent_jobs_agent_run_unique ON app.agent_jobs(agent_run_id)
  WHERE agent_run_id IS NOT NULL;
