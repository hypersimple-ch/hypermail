ALTER TABLE app.agent_activity_events DROP CONSTRAINT agent_activity_events_detail_closed;
ALTER TABLE app.agent_activity_events ADD CONSTRAINT agent_activity_events_detail_closed CHECK((detail->>'type') IN ('run_started','run_completed','run_failed','question_asked','question_answered','sensitive_read_summary','authorization_denied','action_authorized','action_started','action_provider_reported','action_verified','action_failed','action_unverifiable','no_action','safety_event','external_drift','send_approval_requested','send_approval_begun','send_rejected','send_approved','send_failed','send_unverifiable'));

-- PostgreSQL forbids using newly appended enum values before commit, while
-- drizzle-kit batches all pending migrations in one transaction. Replace the small
-- pre-release enum atomically so later statements can use the full vocabulary now.
ALTER TYPE app.public_send_request_state RENAME TO public_send_request_state_legacy;
CREATE TYPE app.public_send_request_state AS ENUM('pending_owner_approval','expired','cancelled','approved','rejected','sending','failed','unverifiable');
ALTER TABLE app.public_mcp_send_requests ALTER COLUMN state DROP DEFAULT;
ALTER TABLE app.public_mcp_send_requests ALTER COLUMN state TYPE app.public_send_request_state USING state::text::app.public_send_request_state;
ALTER TABLE app.public_mcp_send_requests ALTER COLUMN state SET DEFAULT 'pending_owner_approval';
DROP TYPE app.public_send_request_state_legacy;
--> statement-breakpoint

ALTER TABLE app.public_mcp_send_requests
 ADD COLUMN approval_id uuid UNIQUE REFERENCES app.send_approvals(id) ON DELETE RESTRICT,
 ADD COLUMN run_id uuid UNIQUE,
 ADD COLUMN action_id uuid UNIQUE,
 ADD COLUMN provider_message_id text,
 ADD COLUMN completed_at timestamptz,
 ADD COLUMN reason_code text CHECK(reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_]{0,99}$');
ALTER TABLE app.send_approvals ADD COLUMN public_send_request_id uuid UNIQUE REFERENCES app.public_mcp_send_requests(id) ON DELETE RESTRICT;
ALTER TABLE app.public_mcp_send_requests ADD CONSTRAINT public_send_request_owned_run FOREIGN KEY(run_id,user_id,account_id) REFERENCES app.agent_runs(id,user_id,account_id) ON DELETE RESTRICT;
ALTER TABLE app.public_mcp_send_requests ADD CONSTRAINT public_send_request_owned_action FOREIGN KEY(action_id,user_id,account_id) REFERENCES app.agent_authorized_actions(id,user_id,account_id) ON DELETE RESTRICT;

DROP TRIGGER public_send_request_transition ON app.public_mcp_send_requests;
DROP FUNCTION app.enforce_public_send_request_transition();
CREATE FUNCTION app.enforce_public_send_request_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.state <> 'pending_owner_approval' OR NEW.approval_id IS NOT NULL OR NEW.run_id IS NOT NULL OR NEW.action_id IS NOT NULL OR NEW.provider_message_id IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.reason_code IS NOT NULL THEN
   RAISE EXCEPTION 'new send request must begin pending without execution fields';
  END IF;
  RETURN NEW;
 END IF;
 IF (NEW.user_id,NEW.account_id,NEW.connection_id,NEW.draft_id,NEW.draft_version,NEW.activity_id,NEW.authorization_decision_id,NEW.lifecycle_revision,NEW.assignment_revision,NEW.grant_revision,NEW.safety_revision,NEW.created_at,NEW.expires_at)
 IS DISTINCT FROM (OLD.user_id,OLD.account_id,OLD.connection_id,OLD.draft_id,OLD.draft_version,OLD.activity_id,OLD.authorization_decision_id,OLD.lifecycle_revision,OLD.assignment_revision,OLD.grant_revision,OLD.safety_revision,OLD.created_at,OLD.expires_at) THEN RAISE EXCEPTION 'send request identity is immutable'; END IF;
 IF OLD.approval_id IS NOT NULL AND NEW.approval_id IS DISTINCT FROM OLD.approval_id THEN RAISE EXCEPTION 'send request approval link is immutable'; END IF;
 IF OLD.run_id IS NOT NULL AND NEW.run_id IS DISTINCT FROM OLD.run_id THEN RAISE EXCEPTION 'send request run link is immutable'; END IF;
 IF OLD.action_id IS NOT NULL AND NEW.action_id IS DISTINCT FROM OLD.action_id THEN RAISE EXCEPTION 'send request action link is immutable'; END IF;
 IF OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id THEN RAISE EXCEPTION 'send request provider identity is immutable'; END IF;
 IF OLD.completed_at IS NOT NULL AND (NEW.completed_at,NEW.reason_code) IS DISTINCT FROM (OLD.completed_at,OLD.reason_code) THEN RAISE EXCEPTION 'send request terminal result is immutable'; END IF;
 IF NEW.state IS NOT DISTINCT FROM OLD.state AND OLD.reason_code IS NOT NULL AND NEW.reason_code IS DISTINCT FROM OLD.reason_code THEN RAISE EXCEPTION 'send request reason is immutable within a state'; END IF;
 IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
  (OLD.state='pending_owner_approval' AND NEW.state IN ('expired','cancelled','rejected','sending')) OR
  (OLD.state='sending' AND NEW.state IN ('approved','failed','unverifiable')) OR
  (OLD.state='unverifiable' AND NEW.state IN ('approved','failed'))
 ) THEN RAISE EXCEPTION 'illegal send request transition % -> %', OLD.state, NEW.state; END IF;
 IF NEW.state IS DISTINCT FROM OLD.state AND NEW.updated_at <= OLD.updated_at THEN RAISE EXCEPTION 'send request transition must advance updated_at'; END IF;
 IF NEW.state IN ('approved','failed','rejected','expired','cancelled') AND NEW.completed_at IS NULL THEN RAISE EXCEPTION 'terminal send request requires completion time'; END IF;
 IF NEW.state='pending_owner_approval' AND (NEW.run_id IS NOT NULL OR NEW.action_id IS NOT NULL OR NEW.provider_message_id IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.reason_code IS NOT NULL) THEN RAISE EXCEPTION 'pending send request has execution result fields'; END IF;
 IF NEW.state='sending' AND (NEW.provider_message_id IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.reason_code IS NOT NULL) THEN RAISE EXCEPTION 'sending request cannot claim a result'; END IF;
 IF NEW.state='unverifiable' AND (NEW.provider_message_id IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.reason_code IS NULL) THEN RAISE EXCEPTION 'unverifiable request requires only a reason code'; END IF;
 IF NEW.state='approved' AND (NEW.completed_at IS NULL OR NEW.reason_code IS NOT NULL) THEN RAISE EXCEPTION 'approved request result fields are inconsistent'; END IF;
 IF NEW.state IN ('failed','rejected','expired','cancelled') AND NEW.reason_code IS NULL THEN RAISE EXCEPTION 'non-approved terminal request requires a reason code'; END IF;
 IF NEW.state='sending' AND (NEW.approval_id IS NULL OR NEW.run_id IS NULL OR NEW.action_id IS NULL OR NOT EXISTS(SELECT 1 FROM app.send_approvals sa WHERE sa.id=NEW.approval_id AND sa.state='consumed') OR NOT EXISTS(SELECT 1 FROM app.agent_runs r WHERE r.id=NEW.run_id AND r.state='running') OR NOT EXISTS(SELECT 1 FROM app.agent_authorized_actions a WHERE a.id=NEW.action_id AND a.state IN ('executing','verifying'))) THEN RAISE EXCEPTION 'sending request requires consumed approval and executing canonical action'; END IF;
 IF NEW.state='approved' AND (NEW.provider_message_id IS NULL OR NEW.action_id IS NULL OR NOT EXISTS(SELECT 1 FROM app.agent_authorized_actions a JOIN app.agent_action_verifications v ON v.action_id=a.id WHERE a.id=NEW.action_id AND a.state='verified' AND v.verifier='hypermail_provider_readback' AND v.provider_mutation_id=NEW.provider_message_id) OR NOT EXISTS(SELECT 1 FROM app.agent_runs r WHERE r.id=NEW.run_id AND r.state='completed' AND r.outcome='action_requests_emitted' AND r.error_code IS NULL)) THEN RAISE EXCEPTION 'approved send request requires matching Hypermail readback evidence'; END IF;
 IF NEW.state='failed' AND (NOT EXISTS(SELECT 1 FROM app.agent_authorized_actions a WHERE a.id=NEW.action_id AND a.state='failed' AND a.error_code=NEW.reason_code) OR NOT EXISTS(SELECT 1 FROM app.agent_runs r WHERE r.id=NEW.run_id AND r.state='completed' AND r.outcome='failed' AND r.error_code=NEW.reason_code)) THEN RAISE EXCEPTION 'failed request requires matching failed canonical action and Run'; END IF;
 IF NEW.state='unverifiable' AND NOT EXISTS(SELECT 1 FROM app.agent_authorized_actions a WHERE a.id=NEW.action_id AND a.state IN ('executing','verifying')) THEN RAISE EXCEPTION 'unverifiable request requires unverifiable canonical action'; END IF;
 IF NEW.approval_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.send_approvals sa WHERE sa.id=NEW.approval_id AND sa.public_send_request_id=NEW.id AND sa.draft_id=NEW.draft_id AND sa.draft_version=NEW.draft_version AND sa.user_id=NEW.user_id) THEN RAISE EXCEPTION 'send approval linkage mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER public_send_request_transition BEFORE INSERT OR UPDATE ON app.public_mcp_send_requests FOR EACH ROW EXECUTE FUNCTION app.enforce_public_send_request_transition();
CREATE INDEX public_send_request_reconciliation ON app.public_mcp_send_requests(state,updated_at) WHERE state IN ('sending','unverifiable');
