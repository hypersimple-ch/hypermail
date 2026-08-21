ALTER TABLE app.agent_authorized_actions DROP CONSTRAINT agent_actions_target_contract;
ALTER TABLE app.agent_authorized_actions ADD CONSTRAINT agent_actions_target_contract CHECK((kind IN ('archive','recoverable_trash','move','mark_read','mark_unread') AND target ? 'messageId') OR (kind='draft_create' AND target ? 'requestId') OR (kind IN ('draft_edit','send') AND target ? 'draftId'));
CREATE TRIGGER agent_connections_record_initial_lifecycle_revision AFTER INSERT ON app.agent_connections FOR EACH ROW EXECUTE FUNCTION app.record_connection_lifecycle_revision();
ALTER TABLE app.agent_activity_events DROP CONSTRAINT agent_activity_events_detail_closed;
ALTER TABLE app.agent_activity_events ADD CONSTRAINT agent_activity_events_detail_closed CHECK((detail->>'type') IN ('run_started','run_completed','run_failed','question_asked','question_answered','sensitive_read_summary','authorization_denied','action_authorized','action_started','action_provider_reported','action_verified','action_failed','action_unverifiable','no_action','safety_event','external_drift','send_approval_requested'));
CREATE TYPE "app"."public_send_request_state" AS ENUM('pending_owner_approval','expired','cancelled','approved');
CREATE TABLE "app"."public_mcp_send_requests" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
 "user_id" uuid NOT NULL, "account_id" uuid NOT NULL, "connection_id" uuid NOT NULL,
 "draft_id" uuid NOT NULL REFERENCES "app"."drafts"("id") ON DELETE RESTRICT,
 "draft_version" integer NOT NULL CHECK(draft_version>0), "activity_id" uuid NOT NULL, "authorization_decision_id" uuid NOT NULL, "lifecycle_revision" integer NOT NULL, "assignment_revision" integer NOT NULL, "grant_revision" integer NOT NULL, "safety_revision" integer NOT NULL,
 "state" "app"."public_send_request_state" DEFAULT 'pending_owner_approval' NOT NULL,
 "expires_at" timestamptz NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL,
 CONSTRAINT "public_send_request_owner" FOREIGN KEY("user_id","account_id") REFERENCES "app"."user_accounts"("user_id","account_id") ON DELETE RESTRICT,
 CONSTRAINT "public_send_request_connection" FOREIGN KEY("user_id","connection_id") REFERENCES "app"."agent_connections"("user_id","id") ON DELETE RESTRICT,
 CONSTRAINT "public_send_request_activity" FOREIGN KEY("activity_id","user_id","account_id") REFERENCES "app"."agent_activities"("id","user_id","account_id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "public_send_request_retry_unique" ON "app"."public_mcp_send_requests"("user_id","account_id","connection_id","draft_id","draft_version");
CREATE INDEX "public_send_request_owner_pending" ON "app"."public_mcp_send_requests"("user_id","state","created_at");

CREATE FUNCTION app.enforce_public_send_request_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.user_id,NEW.account_id,NEW.connection_id,NEW.draft_id,NEW.draft_version,NEW.activity_id,NEW.authorization_decision_id,NEW.lifecycle_revision,NEW.assignment_revision,NEW.grant_revision,NEW.safety_revision,NEW.created_at,NEW.expires_at) IS DISTINCT FROM (OLD.user_id,OLD.account_id,OLD.connection_id,OLD.draft_id,OLD.draft_version,OLD.activity_id,OLD.authorization_decision_id,OLD.lifecycle_revision,OLD.assignment_revision,OLD.grant_revision,OLD.safety_revision,OLD.created_at,OLD.expires_at) THEN RAISE EXCEPTION 'send request identity is immutable'; END IF;
 IF NEW.state IS DISTINCT FROM OLD.state AND OLD.state <> 'pending_owner_approval' THEN RAISE EXCEPTION 'terminal send request cannot transition'; END IF;
 IF NEW.state IS DISTINCT FROM OLD.state AND NEW.updated_at <= OLD.updated_at THEN RAISE EXCEPTION 'send request transition must advance updated_at'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER public_send_request_transition BEFORE UPDATE ON app.public_mcp_send_requests FOR EACH ROW EXECUTE FUNCTION app.enforce_public_send_request_transition();
