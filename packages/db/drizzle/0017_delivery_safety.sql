ALTER TABLE app.users ADD COLUMN autonomy_paused_at timestamptz;
CREATE TABLE app.policy_safety_samples (
 action_id uuid PRIMARY KEY,user_id uuid NOT NULL,account_id uuid NOT NULL,outcome text NOT NULL,observed_at timestamptz NOT NULL,
 FOREIGN KEY(action_id,user_id,account_id) REFERENCES app.agent_authorized_actions(id,user_id,account_id),CHECK(outcome IN ('succeeded','incorrect'))
);
CREATE INDEX policy_safety_samples_window ON app.policy_safety_samples(account_id,observed_at);
CREATE FUNCTION app.guard_safety_sample() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.agent_authorized_actions WHERE id=NEW.action_id AND kind IN ('archive','move','recoverable_trash') AND ((NEW.outcome='succeeded' AND state='verified') OR (NEW.outcome='incorrect' AND error_code='VERIFICATION_MISMATCH'))) THEN RAISE EXCEPTION 'sample requires verified classification or observed mismatch'; END IF; RETURN NEW; END $$;
CREATE TRIGGER safety_sample_valid BEFORE INSERT ON app.policy_safety_samples FOR EACH ROW EXECUTE FUNCTION app.guard_safety_sample();
CREATE TRIGGER safety_samples_append_only BEFORE UPDATE OR DELETE ON app.policy_safety_samples FOR EACH ROW EXECUTE FUNCTION app.reject_canonical_history_mutation();
ALTER TABLE app.agent_authorized_actions ADD COLUMN verification_cursor jsonb,ADD COLUMN verification_deadline_at timestamptz;
ALTER TABLE app.logical_notifications ADD COLUMN targets_initialized_at timestamptz,ADD COLUMN delivered_count integer NOT NULL DEFAULT 0,ADD COLUMN failed_count integer NOT NULL DEFAULT 0,ADD COLUMN pending_count integer NOT NULL DEFAULT 0,
 ADD CONSTRAINT logical_notifications_counts CHECK(delivered_count>=0 AND failed_count>=0 AND pending_count>=0);
CREATE TABLE app.notification_targets (
 notification_id uuid NOT NULL REFERENCES app.logical_notifications(id),subscription_id uuid NOT NULL REFERENCES app.push_subscriptions(id),state text NOT NULL DEFAULT 'pending',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(notification_id,subscription_id),CHECK(state IN ('pending','delivered','failed','suppressed'))
);
ALTER TABLE app.notification_deliveries ADD COLUMN claim_token uuid,ADD COLUMN claim_expires_at timestamptz;
-- Old unleased attempts cannot safely finish after upgrade; retain them as retryable history.
UPDATE app.notification_deliveries SET state='retryable',error_code='DELIVERY_LEASE_EXPIRED',finished_at=now() WHERE state='pending';
INSERT INTO app.notification_targets(notification_id,subscription_id,state)
 SELECT d.notification_id,d.subscription_id,CASE WHEN bool_or(d.state='succeeded') THEN 'delivered' WHEN s.disabled_at IS NOT NULL THEN 'suppressed' WHEN bool_or(d.state='permanent_failure') OR max(d.attempt)>=3 THEN 'failed' ELSE 'pending' END FROM app.notification_deliveries d JOIN app.push_subscriptions s ON s.id=d.subscription_id GROUP BY d.notification_id,d.subscription_id,s.disabled_at;
ALTER TABLE app.notification_deliveries ADD CONSTRAINT delivery_claim_shape CHECK((state='pending' AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL) OR (state<>'pending' AND claim_expires_at IS NULL));
CREATE INDEX notification_deliveries_expired ON app.notification_deliveries(claim_expires_at) WHERE state='pending';
CREATE FUNCTION app.guard_delivery_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (NEW.id,NEW.notification_id,NEW.subscription_id,NEW.attempt,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.notification_id,OLD.subscription_id,OLD.attempt,OLD.created_at) THEN RAISE EXCEPTION 'delivery identity immutable'; END IF;
 IF OLD.state<>'pending' OR NEW.claim_token IS DISTINCT FROM OLD.claim_token THEN RAISE EXCEPTION 'delivery claim fence mismatch'; END IF;
 IF NEW.state='pending' AND (OLD.claim_expires_at<=now() OR NEW.claim_expires_at<=OLD.claim_expires_at) THEN RAISE EXCEPTION 'stale delivery renewal'; END IF;
 IF NEW.state<>'pending' AND OLD.claim_expires_at<=now() AND NOT (NEW.state='retryable' AND NEW.error_code='DELIVERY_LEASE_EXPIRED') THEN RAISE EXCEPTION 'expired delivery cannot finish'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER notification_delivery_fence BEFORE UPDATE OR DELETE ON app.notification_deliveries FOR EACH ROW EXECUTE FUNCTION app.guard_delivery_claim();
CREATE FUNCTION app.guard_notification_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  PERFORM 1 FROM app.logical_notifications WHERE id=NEW.notification_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM app.logical_notifications WHERE id=NEW.notification_id AND targets_initialized_at IS NOT NULL) THEN RAISE EXCEPTION 'notification fan-out is frozen'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app.logical_notifications n JOIN app.activities a ON a.id=n.activity_id JOIN app.user_accounts ua ON ua.account_id=a.account_id JOIN app.push_subscriptions s ON s.user_id=ua.user_id WHERE n.id=NEW.notification_id AND s.id=NEW.subscription_id) THEN RAISE EXCEPTION 'notification target owner mismatch'; END IF;
 ELSE
  IF TG_OP='DELETE' OR (NEW.notification_id,NEW.subscription_id,NEW.created_at) IS DISTINCT FROM (OLD.notification_id,OLD.subscription_id,OLD.created_at) OR OLD.state IN ('delivered','suppressed') THEN RAISE EXCEPTION 'notification target immutable'; END IF;
 END IF; RETURN NEW; END $$;
CREATE TRIGGER notification_target_guard BEFORE INSERT OR UPDATE OR DELETE ON app.notification_targets FOR EACH ROW EXECUTE FUNCTION app.guard_notification_target();

CREATE OR REPLACE FUNCTION app.enforce_agent_action_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Agent Actions are immutable history'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','error_code','started_at','provider_reported_at','completed_at','verification_cursor','verification_deadline_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','error_code','started_at','provider_reported_at','completed_at','verification_cursor','verification_deadline_at']) THEN RAISE EXCEPTION 'Agent Action identity is immutable'; END IF;
 IF OLD.verification_deadline_at IS NOT NULL AND NEW.verification_deadline_at IS DISTINCT FROM OLD.verification_deadline_at THEN RAISE EXCEPTION 'verification deadline is immutable'; END IF;
 IF OLD.state IN ('executing','verifying') AND NEW.state=OLD.state AND (NEW.started_at,NEW.provider_reported_at,NEW.completed_at,NEW.error_code) IS NOT DISTINCT FROM (OLD.started_at,OLD.provider_reported_at,OLD.completed_at,OLD.error_code) THEN RETURN NEW; END IF;
 IF OLD.state IN ('verified','failed','unverifiable','cancelled') OR NOT ((OLD.state='authorized' AND NEW.state IN ('executing','failed','unverifiable','cancelled')) OR (OLD.state='executing' AND NEW.state IN ('verifying','verified','failed','unverifiable','cancelled') AND NEW.started_at=OLD.started_at AND (NEW.state<>'verified' OR NEW.provider_reported_at IS NULL)) OR (OLD.state='verifying' AND NEW.state IN ('verified','failed','unverifiable','cancelled') AND NEW.started_at=OLD.started_at AND NEW.provider_reported_at=OLD.provider_reported_at)) THEN RAISE EXCEPTION 'illegal Agent Action transition'; END IF;
 RETURN NEW; END $$;

CREATE FUNCTION app.fence_automatic_proposal_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p app.agent_action_proposals%ROWTYPE; capability text;
BEGIN
 IF OLD.state<>'authorized' OR NEW.state<>'executing' OR NEW.mode<>'automatic' THEN RETURN NEW; END IF;
 IF NEW.kind NOT IN ('archive','move','recoverable_trash','draft_create','draft_edit') THEN RAISE EXCEPTION 'automatic capability forbidden'; END IF;
 capability:=CASE NEW.kind WHEN 'archive' THEN 'mail.archive' WHEN 'move' THEN 'mail.move' WHEN 'recoverable_trash' THEN 'mail.trash_recoverable' WHEN 'draft_create' THEN 'draft.create' WHEN 'draft_edit' THEN 'draft.edit' END;
 SELECT * INTO p FROM app.agent_action_proposals WHERE authorized_action_id=NEW.id FOR SHARE;
 IF p.id IS NULL THEN RAISE EXCEPTION 'automatic action requires v2 proposal'; END IF;
 IF EXISTS(SELECT 1 FROM app.users WHERE id=NEW.user_id AND autonomy_paused_at IS NOT NULL) OR EXISTS(SELECT 1 FROM app.accounts WHERE id=NEW.account_id AND autonomy_paused_at IS NOT NULL) THEN RAISE EXCEPTION 'AUTONOMY_PAUSED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.mailbox_manager_assignments WHERE id=NEW.assignment_id AND user_id=NEW.user_id AND account_id=NEW.account_id AND revision=NEW.assignment_revision AND automatic_processing_enabled AND manager_kind::text=NEW.manager_kind::text AND agent_connection_id IS NOT DISTINCT FROM NEW.manager_connection_id) OR NOT EXISTS(SELECT 1 FROM app.agent_capability_grants WHERE id=NEW.grant_id AND user_id=NEW.user_id AND account_id=NEW.account_id AND revision=NEW.grant_revision AND state='active' AND capability=ANY(capabilities) AND 'automatic'=ANY(invocation_modes)) OR NOT EXISTS(SELECT 1 FROM app.agent_safety_ceiling WHERE revision=NEW.safety_revision AND capability=ANY(capabilities) AND 'automatic'=ANY(invocation_modes)) THEN RAISE EXCEPTION 'CAPABILITY_NOT_GRANTED'; END IF;
 IF NEW.manager_connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.agent_connections WHERE id=NEW.manager_connection_id AND user_id=NEW.user_id AND lifecycle_revision=NEW.manager_lifecycle_revision AND state='connected') THEN RAISE EXCEPTION 'MANAGER_UNAVAILABLE'; END IF;
 IF p.origin='model' AND p.confidence<p.threshold AND NOT EXISTS(SELECT 1 FROM app.agent_action_reviews WHERE proposal_id=p.id AND decision='approve') THEN RAISE EXCEPTION 'proposal approval required'; END IF;
 IF p.origin='owner' AND NOT EXISTS(SELECT 1 FROM app.agent_action_reviews WHERE successor_proposal_id=p.id AND decision='correct') THEN RAISE EXCEPTION 'owner correction review required'; END IF;
 IF EXISTS(SELECT 1 FROM app.agent_proposal_dependencies d JOIN app.agent_action_proposals dep ON dep.id=d.depends_on_id LEFT JOIN app.agent_authorized_actions a ON a.id=dep.authorized_action_id WHERE d.proposal_id=p.id AND a.state IS DISTINCT FROM 'verified') THEN RAISE EXCEPTION 'dependency not verified'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER automatic_proposal_mutation_fence BEFORE UPDATE ON app.agent_authorized_actions FOR EACH ROW EXECUTE FUNCTION app.fence_automatic_proposal_mutation();
CREATE FUNCTION app.validate_delivery_claim_insert() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE prior_attempt integer; BEGIN
 PERFORM 1 FROM app.logical_notifications WHERE id=NEW.notification_id FOR UPDATE;
 SELECT coalesce(max(attempt),0) INTO prior_attempt FROM app.notification_deliveries WHERE notification_id=NEW.notification_id AND subscription_id=NEW.subscription_id;
 IF NEW.attempt<>prior_attempt+1 OR NEW.attempt>3 OR NEW.state<>'pending' OR NEW.claim_expires_at<=now() OR NEW.claim_expires_at>now()+interval '120 seconds' OR NOT EXISTS(SELECT 1 FROM app.notification_targets WHERE notification_id=NEW.notification_id AND subscription_id=NEW.subscription_id AND state IN ('pending','failed')) THEN RAISE EXCEPTION 'invalid durable notification claim'; END IF;
 IF EXISTS(SELECT 1 FROM app.notification_deliveries WHERE notification_id=NEW.notification_id AND subscription_id=NEW.subscription_id AND state='pending') THEN RAISE EXCEPTION 'prior delivery claim must be expired before reclaim'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER notification_delivery_claim_insert BEFORE INSERT ON app.notification_deliveries FOR EACH ROW EXECUTE FUNCTION app.validate_delivery_claim_insert();
-- Freeze existing recipients at the already-observed fan-out; never add later devices.
UPDATE app.logical_notifications n SET targets_initialized_at=x.started_at FROM (
 SELECT notification_id,min(created_at) AS started_at FROM app.notification_deliveries GROUP BY notification_id
) x WHERE n.id=x.notification_id;
UPDATE app.logical_notifications n SET delivered_count=x.delivered,failed_count=x.failed,pending_count=x.pending,
 state=CASE WHEN x.pending>0 THEN 'pending'::app.notification_state WHEN x.failed>0 THEN 'failed'::app.notification_state WHEN x.delivered>0 THEN 'delivered'::app.notification_state ELSE 'suppressed'::app.notification_state END
FROM (SELECT notification_id,count(*) FILTER(WHERE state='delivered')::integer AS delivered,count(*) FILTER(WHERE state='failed')::integer AS failed,count(*) FILTER(WHERE state='pending')::integer AS pending FROM app.notification_targets GROUP BY notification_id) x WHERE n.id=x.notification_id;
