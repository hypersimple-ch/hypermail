-- Repair the Phase-B upgrade gap: legacy Activities/jobs may predate canonical dual-write.
-- Identity is shared deliberately, so existing agent_jobs can safely create canonical Runs.
INSERT INTO app.agent_activities
  (id,user_id,account_id,kind,source_message_id,correlation_id,causation_id,state,revision,created_at,updated_at)
SELECT a.id,ac.user_id,a.account_id,'arrival',a.message_id,'arrival:'||a.id::text,NULL,
       CASE WHEN a.state IN ('handled','acknowledged') THEN 'resolved'::app.agent_activity_state
            WHEN a.state='failed' THEN 'attention_required'::app.agent_activity_state
            ELSE 'open'::app.agent_activity_state END,
       1,a.created_at,a.updated_at
FROM app.activities a JOIN app.accounts ac ON ac.id=a.account_id
ON CONFLICT(id) DO NOTHING;

-- Durable automatic-task delivery (Issues #9/#10).
-- 0007 predates durable Tasks. Keep the trigger vocabulary closed while admitting
-- the only new canonical trigger emitted by this migration/store.
ALTER TABLE app.agent_runs DROP CONSTRAINT agent_runs_trigger_closed;
ALTER TABLE app.agent_runs ADD CONSTRAINT agent_runs_trigger_closed
  CHECK ((trigger->>'kind') IN ('arrival','interactive_request','question_answer','retry','legacy_projection','automatic_task'));

CREATE TYPE "app"."agent_task_state" AS ENUM('pending','leased','waiting_for_answer','awaiting_action_verification','completed','cancelled','obsolete','dead_letter');
CREATE TYPE "app"."agent_task_pending_reason" AS ENUM('initial','retry','continuation','owner_resumed');
CREATE TYPE "app"."agent_task_error_code" AS ENUM('MANAGER_UNAVAILABLE','RATE_LIMITED','DEPENDENCY_UNAVAILABLE','LEASE_EXPIRED','DEADLINE_EXCEEDED','INVALID_REPORT','AUTHORIZATION_REVOKED','OWNER_CANCELLED','INTERNAL','UNVERIFIABLE');
CREATE TYPE "app"."agent_task_outbox_event" AS ENUM('task_available','task_obsolete','question_answered','task_terminal');
CREATE TYPE "app"."agent_task_report_kind" AS ENUM('heartbeat','result','failure','answer');

CREATE TABLE "app"."agent_tasks" (
 "id" uuid PRIMARY KEY, "enqueue_key" text NOT NULL, "activity_id" uuid NOT NULL, "user_id" uuid NOT NULL, "account_id" uuid NOT NULL,
 "manager_kind" "app"."mailbox_manager_kind" NOT NULL, "manager_connection_id" uuid, "manager_lifecycle_revision" integer,
 "assignment_id" uuid NOT NULL, "assignment_revision" integer NOT NULL, "grant_id" uuid NOT NULL, "grant_revision" integer NOT NULL, "safety_revision" integer NOT NULL,
 "state" "app"."agent_task_state" DEFAULT 'pending' NOT NULL, "pending_reason" "app"."agent_task_pending_reason", "version" integer DEFAULT 1 NOT NULL,
 "attempt_count" integer DEFAULT 0 NOT NULL, "max_attempts" integer DEFAULT 5 NOT NULL, "lease_generation" integer DEFAULT 0 NOT NULL,
 "lease_token_digest" text, "lease_claimed_by" text, "lease_claimed_at" timestamptz, "lease_heartbeat_at" timestamptz, "lease_expires_at" timestamptz, "current_run_id" uuid,
 "result" jsonb, "last_error_code" "app"."agent_task_error_code", "available_at" timestamptz NOT NULL, "deadline_at" timestamptz NOT NULL,
 "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL, "completed_at" timestamptz, "obsolete_at" timestamptz,
 CONSTRAINT "agent_tasks_enqueue_key_unique" UNIQUE("enqueue_key"),
 CONSTRAINT "agent_tasks_identity_unique" UNIQUE("id","user_id","account_id"),
 CONSTRAINT "agent_tasks_activity_fk" FOREIGN KEY("activity_id","user_id","account_id") REFERENCES "app"."agent_activities"("id","user_id","account_id") ON DELETE restrict,
 CONSTRAINT "agent_tasks_assignment_revision_fk" FOREIGN KEY("assignment_id","assignment_revision") REFERENCES "app"."mailbox_manager_assignment_revisions"("assignment_id","revision") ON DELETE restrict,
 CONSTRAINT "agent_tasks_grant_revision_fk" FOREIGN KEY("grant_id","grant_revision") REFERENCES "app"."agent_capability_grant_revisions"("grant_id","revision") ON DELETE restrict,
 CONSTRAINT "agent_tasks_run_fk" FOREIGN KEY("current_run_id","user_id","account_id") REFERENCES "app"."agent_runs"("id","user_id","account_id") ON DELETE restrict,
 CONSTRAINT "agent_tasks_manager_reference" CHECK ((manager_kind='mastra' AND manager_connection_id IS NULL AND manager_lifecycle_revision IS NULL) OR (manager_kind='agent_connection' AND manager_connection_id IS NOT NULL AND manager_lifecycle_revision IS NOT NULL)),
 CONSTRAINT "agent_tasks_positive_fences" CHECK (version>0 AND assignment_revision>0 AND grant_revision>0 AND safety_revision>0 AND attempt_count>=0 AND max_attempts>0 AND attempt_count<=max_attempts AND lease_generation>=0),
 CONSTRAINT "agent_tasks_lease_shape" CHECK ((state='leased' AND lease_token_digest IS NOT NULL AND lease_claimed_by IS NOT NULL AND lease_claimed_at IS NOT NULL AND lease_heartbeat_at IS NOT NULL AND lease_expires_at IS NOT NULL AND current_run_id IS NOT NULL) OR (state<>'leased' AND lease_token_digest IS NULL AND lease_claimed_by IS NULL AND lease_claimed_at IS NULL AND lease_heartbeat_at IS NULL AND lease_expires_at IS NULL AND current_run_id IS NULL)),
 CONSTRAINT "agent_tasks_time_bounds" CHECK (available_at<=deadline_at AND created_at<=deadline_at)
);
CREATE INDEX "agent_tasks_claim_idx" ON "app"."agent_tasks"("manager_kind","manager_connection_id","available_at","created_at") WHERE state='pending';
CREATE INDEX "agent_tasks_expired_lease_idx" ON "app"."agent_tasks"("lease_expires_at") WHERE state='leased';

CREATE TABLE "app"."agent_task_delivery_attempts" (
 "id" uuid PRIMARY KEY, "task_id" uuid NOT NULL REFERENCES "app"."agent_tasks"("id") ON DELETE restrict, "number" integer NOT NULL, "lease_generation" integer NOT NULL, "run_id" uuid NOT NULL REFERENCES "app"."agent_runs"("id") ON DELETE restrict,
 "manager_kind" "app"."mailbox_manager_kind" NOT NULL, "manager_connection_id" uuid, "request_id" text NOT NULL, "request_digest" text NOT NULL,
 "started_at" timestamptz NOT NULL, "ended_at" timestamptz, "error_code" "app"."agent_task_error_code",
 CONSTRAINT "agent_task_attempt_number_unique" UNIQUE("task_id","number"), CONSTRAINT "agent_task_attempt_generation_unique" UNIQUE("task_id","lease_generation"), CONSTRAINT "agent_task_attempt_request_unique" UNIQUE("task_id","request_id")
);
CREATE TABLE "app"."agent_task_reports" (
 "id" uuid PRIMARY KEY, "task_id" uuid NOT NULL REFERENCES "app"."agent_tasks"("id") ON DELETE restrict, "attempt_id" uuid REFERENCES "app"."agent_task_delivery_attempts"("id") ON DELETE restrict,
 "lease_generation" integer NOT NULL, "kind" "app"."agent_task_report_kind" NOT NULL, "request_id" text NOT NULL, "request_digest" text NOT NULL, "accepted" boolean NOT NULL, "error_code" "app"."agent_task_error_code", "occurred_at" timestamptz NOT NULL, "response_snapshot" jsonb NOT NULL,
 CONSTRAINT "agent_task_reports_request_unique" UNIQUE("task_id","request_id")
);
CREATE TABLE "app"."agent_task_receipts" (
 "id" uuid PRIMARY KEY, "task_id" uuid NOT NULL REFERENCES "app"."agent_tasks"("id") ON DELETE restrict, "outbox_id" uuid, "transport" text NOT NULL, "receipt_id" text NOT NULL, "received_at" timestamptz NOT NULL,
 CONSTRAINT "agent_task_receipts_transport_unique" UNIQUE("transport","receipt_id")
);
CREATE TABLE "app"."agent_task_outbox" (
 "id" uuid PRIMARY KEY, "task_id" uuid NOT NULL REFERENCES "app"."agent_tasks"("id") ON DELETE restrict, "activity_id" uuid NOT NULL, "account_id" uuid NOT NULL,
 "event" "app"."agent_task_outbox_event" NOT NULL, "task_version" integer NOT NULL, "payload_digest" text NOT NULL, "correlation_id" text NOT NULL, "occurred_at" timestamptz NOT NULL,
 "available_at" timestamptz NOT NULL, "published_at" timestamptz, "claim_token" uuid, "claimed_at" timestamptz, "publish_attempts" integer DEFAULT 0 NOT NULL, "last_error" text, "dead_lettered_at" timestamptz,
 CONSTRAINT "agent_task_outbox_version_event_unique" UNIQUE("task_id","task_version","event")
);
CREATE INDEX "agent_task_outbox_pending_idx" ON "app"."agent_task_outbox"("available_at","occurred_at") WHERE published_at IS NULL;
CREATE TABLE "app"."agent_task_blocks" (
 "activity_id" uuid PRIMARY KEY REFERENCES "app"."agent_activities"("id") ON DELETE restrict,
 "user_id" uuid NOT NULL, "account_id" uuid NOT NULL, "reason" text NOT NULL,
 "available_at" timestamptz NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL,
 "updated_at" timestamptz DEFAULT now() NOT NULL,
 CONSTRAINT "agent_task_blocks_tenant_fk" FOREIGN KEY("activity_id","user_id","account_id") REFERENCES "app"."agent_activities"("id","user_id","account_id") ON DELETE restrict
);

CREATE TABLE "app"."agent_mutation_idempotency" (
 "account_id" uuid NOT NULL REFERENCES "app"."accounts"("id") ON DELETE restrict, "operation" text NOT NULL, "idempotency_key" text NOT NULL, "request_digest" text NOT NULL,
 "state" text NOT NULL CHECK(state IN ('started','succeeded','failed','unverifiable')), "result" jsonb, "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL,
 PRIMARY KEY("account_id","operation","idempotency_key")
);

CREATE OR REPLACE FUNCTION app.reject_immutable_agent_task_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'agent task history is append-only'; END $$;
-- An Attempt is immutable except for its exactly-once terminalization. Recovery and
-- normal reports both need to close it, but may never rewrite identity/fences.
CREATE OR REPLACE FUNCTION app.guard_agent_task_attempt_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'agent task history is append-only'; END IF;
 IF ROW(NEW.id,NEW.task_id,NEW.number,NEW.lease_generation,NEW.run_id,NEW.manager_kind,NEW.manager_connection_id,
        NEW.request_id,NEW.request_digest,NEW.started_at)
    IS DISTINCT FROM
    ROW(OLD.id,OLD.task_id,OLD.number,OLD.lease_generation,OLD.run_id,OLD.manager_kind,OLD.manager_connection_id,
        OLD.request_id,OLD.request_digest,OLD.started_at)
    OR OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL THEN
   RAISE EXCEPTION 'agent task attempt immutable fields or terminal state cannot change';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_task_attempts_append_only BEFORE UPDATE OR DELETE ON app.agent_task_delivery_attempts FOR EACH ROW EXECUTE FUNCTION app.guard_agent_task_attempt_update();
CREATE TRIGGER agent_task_reports_append_only BEFORE UPDATE OR DELETE ON app.agent_task_reports FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_agent_task_history();
CREATE TRIGGER agent_task_receipts_append_only BEFORE UPDATE OR DELETE ON app.agent_task_receipts FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_agent_task_history();
