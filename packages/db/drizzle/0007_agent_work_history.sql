-- Canonical Agent work history. Expand-only: legacy activities/actions remain authoritative until cutover.
CREATE TYPE "app"."agent_activity_kind" AS ENUM('arrival','interactive_request','safety_event','external_change');
CREATE TYPE "app"."agent_activity_state" AS ENUM('open','waiting_for_answer','resolved','attention_required','acknowledged');
CREATE TYPE "app"."agent_run_state" AS ENUM('created','running','completed');
CREATE TYPE "app"."agent_run_outcome" AS ENUM('action_requests_emitted','question_asked','no_action','failed','cancelled');
CREATE TYPE "app"."agent_invocation_mode" AS ENUM('interactive','automatic');
CREATE TYPE "app"."agent_work_manager_kind" AS ENUM('mastra','agent_connection','legacy_mastra');
CREATE TYPE "app"."agent_action_kind" AS ENUM('archive','recoverable_trash','move','mark_read','mark_unread','draft_create','draft_edit','send');
CREATE TYPE "app"."agent_action_state" AS ENUM('authorized','executing','verifying','verified','failed','unverifiable','cancelled');

CREATE UNIQUE INDEX "messages_account_id_unique" ON "app"."messages" ("account_id","id");
CREATE UNIQUE INDEX "mailbox_manager_assignment_revision_tenant_unique" ON "app"."mailbox_manager_assignment_revisions" ("assignment_id","revision","user_id","account_id");
CREATE UNIQUE INDEX "agent_capability_grant_revision_tenant_unique" ON "app"."agent_capability_grant_revisions" ("grant_id","revision","user_id","account_id");

CREATE TABLE "app"."agent_connection_lifecycle_revisions" (
 "connection_id" uuid NOT NULL, "revision" integer NOT NULL, "user_id" uuid NOT NULL,
 "state" "app"."agent_connection_state" NOT NULL, "verified_at" timestamptz NOT NULL,
 "changed_at" timestamptz DEFAULT now() NOT NULL,
 PRIMARY KEY("connection_id","revision"), UNIQUE("connection_id","revision","user_id"),
 CONSTRAINT "agent_connection_lifecycle_revisions_positive" CHECK (revision > 0),
 CONSTRAINT "agent_connection_lifecycle_revisions_connection_fk" FOREIGN KEY("user_id","connection_id") REFERENCES "app"."agent_connections"("user_id","id") ON DELETE RESTRICT
);
INSERT INTO "app"."agent_connection_lifecycle_revisions" (connection_id,revision,user_id,state,verified_at,changed_at)
 SELECT id,lifecycle_revision,user_id,state,verified_at,updated_at FROM "app"."agent_connections";

CREATE TABLE "app"."agent_safety_ceiling_revisions" (
 "singleton" boolean NOT NULL DEFAULT true, "revision" integer NOT NULL,
 "capabilities" text[] NOT NULL, "invocation_modes" text[] NOT NULL, "changed_at" timestamptz NOT NULL,
 PRIMARY KEY("singleton","revision"), UNIQUE("revision"),
 CONSTRAINT "agent_safety_ceiling_revisions_singleton" CHECK(singleton),
 CONSTRAINT "agent_safety_ceiling_revisions_positive" CHECK(revision > 0),
 CONSTRAINT "agent_safety_ceiling_revisions_capabilities_closed" CHECK(capabilities <@ ARRAY['mail.list','mail.search','mail.read','attachment.read','folder.list','mail.archive','mail.trash_recoverable','mail.move','mail.mark_read','mail.mark_unread','draft.create','draft.edit','send.request']::text[] AND app.text_array_is_unique(capabilities)),
 CONSTRAINT "agent_safety_ceiling_revisions_modes_closed" CHECK(invocation_modes <@ ARRAY['interactive','automatic']::text[] AND app.text_array_is_unique(invocation_modes))
);
INSERT INTO "app"."agent_safety_ceiling_revisions" (singleton,revision,capabilities,invocation_modes,changed_at)
 SELECT singleton,revision,capabilities,invocation_modes,updated_at FROM "app"."agent_safety_ceiling";

CREATE FUNCTION app.reject_canonical_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER agent_connection_lifecycle_revisions_append_only BEFORE UPDATE OR DELETE ON app.agent_connection_lifecycle_revisions FOR EACH ROW EXECUTE FUNCTION app.reject_canonical_history_mutation();
CREATE TRIGGER agent_safety_ceiling_revisions_append_only BEFORE UPDATE OR DELETE ON app.agent_safety_ceiling_revisions FOR EACH ROW EXECUTE FUNCTION app.reject_canonical_history_mutation();
CREATE FUNCTION app.record_connection_lifecycle_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO app.agent_connection_lifecycle_revisions(connection_id,revision,user_id,state,verified_at,changed_at) VALUES(NEW.id,NEW.lifecycle_revision,NEW.user_id,NEW.state,NEW.verified_at,NEW.updated_at); RETURN NEW; END $$;
CREATE TRIGGER agent_connections_record_lifecycle_revision AFTER UPDATE OF lifecycle_revision ON app.agent_connections FOR EACH ROW WHEN (NEW.lifecycle_revision IS DISTINCT FROM OLD.lifecycle_revision) EXECUTE FUNCTION app.record_connection_lifecycle_revision();
CREATE FUNCTION app.record_safety_ceiling_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO app.agent_safety_ceiling_revisions(singleton,revision,capabilities,invocation_modes,changed_at) VALUES(NEW.singleton,NEW.revision,NEW.capabilities,NEW.invocation_modes,NEW.updated_at); RETURN NEW; END $$;
CREATE TRIGGER agent_safety_ceiling_record_revision AFTER UPDATE OF revision ON app.agent_safety_ceiling FOR EACH ROW WHEN (NEW.revision IS DISTINCT FROM OLD.revision) EXECUTE FUNCTION app.record_safety_ceiling_revision();

CREATE TABLE app.agent_activities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, account_id uuid NOT NULL,
 kind app.agent_activity_kind NOT NULL, source_message_id uuid, correlation_id text NOT NULL, causation_id uuid,
 state app.agent_activity_state NOT NULL DEFAULT 'open', revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,user_id,account_id), UNIQUE(user_id,account_id,correlation_id),
 CONSTRAINT agent_activities_tenant_fk FOREIGN KEY(user_id,account_id) REFERENCES app.user_accounts(user_id,account_id) ON DELETE RESTRICT,
 CONSTRAINT agent_activities_source_fk FOREIGN KEY(account_id,source_message_id) REFERENCES app.messages(account_id,id) ON DELETE RESTRICT,
 CONSTRAINT agent_activities_revision_positive CHECK(revision > 0),
 CONSTRAINT agent_activities_correlation_nonempty CHECK(length(btrim(correlation_id)) BETWEEN 8 AND 200),
 CONSTRAINT agent_activities_source_contract CHECK((kind='arrival' AND source_message_id IS NOT NULL) OR (kind<>'arrival' AND source_message_id IS NULL)),
 CONSTRAINT agent_activities_chronology CHECK(updated_at >= created_at)
);

CREATE TABLE app.agent_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), activity_id uuid NOT NULL, user_id uuid NOT NULL, account_id uuid NOT NULL,
 sequence integer NOT NULL, manager_kind app.agent_work_manager_kind NOT NULL, manager_connection_id uuid, manager_legacy_source_id text,
 manager_lifecycle_revision integer, assignment_id uuid NOT NULL, assignment_revision integer NOT NULL,
 grant_id uuid NOT NULL, grant_revision integer NOT NULL, safety_revision integer NOT NULL,
 mode app.agent_invocation_mode NOT NULL, trigger jsonb NOT NULL, input_digest text NOT NULL, correlation_id text NOT NULL, causation_id uuid,
 state app.agent_run_state NOT NULL DEFAULT 'created', outcome app.agent_run_outcome, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, completed_at timestamptz,
 UNIQUE(id,user_id,account_id), UNIQUE(activity_id,sequence),
 CONSTRAINT agent_runs_activity_fk FOREIGN KEY(activity_id,user_id,account_id) REFERENCES app.agent_activities(id,user_id,account_id) ON DELETE RESTRICT,
 CONSTRAINT agent_runs_assignment_revision_fk FOREIGN KEY(assignment_id,assignment_revision,user_id,account_id) REFERENCES app.mailbox_manager_assignment_revisions(assignment_id,revision,user_id,account_id) ON DELETE RESTRICT,
 CONSTRAINT agent_runs_grant_revision_fk FOREIGN KEY(grant_id,grant_revision,user_id,account_id) REFERENCES app.agent_capability_grant_revisions(grant_id,revision,user_id,account_id) ON DELETE RESTRICT,
 CONSTRAINT agent_runs_lifecycle_revision_fk FOREIGN KEY(manager_connection_id,manager_lifecycle_revision,user_id) REFERENCES app.agent_connection_lifecycle_revisions(connection_id,revision,user_id) ON DELETE RESTRICT,
 CONSTRAINT agent_runs_safety_revision_fk FOREIGN KEY(safety_revision) REFERENCES app.agent_safety_ceiling_revisions(revision) ON DELETE RESTRICT,
 CONSTRAINT agent_runs_sequence_positive CHECK(sequence>0 AND assignment_revision>0 AND grant_revision>0 AND safety_revision>0), CONSTRAINT agent_runs_digest CHECK(input_digest ~ '^[a-f0-9]{64}$'),
 CONSTRAINT agent_runs_manager_contract CHECK((manager_kind='agent_connection' AND manager_connection_id IS NOT NULL AND manager_lifecycle_revision IS NOT NULL AND manager_legacy_source_id IS NULL) OR (manager_kind='mastra' AND manager_connection_id IS NULL AND manager_lifecycle_revision IS NULL AND manager_legacy_source_id IS NULL) OR (manager_kind='legacy_mastra' AND manager_connection_id IS NULL AND manager_lifecycle_revision IS NULL AND length(btrim(manager_legacy_source_id))>0)),
 CONSTRAINT agent_runs_trigger_closed CHECK((trigger->>'kind') IN ('arrival','interactive_request','question_answer','retry','legacy_projection')),
 CONSTRAINT agent_runs_state_contract CHECK((state='created' AND started_at IS NULL AND completed_at IS NULL AND outcome IS NULL) OR (state='running' AND started_at IS NOT NULL AND completed_at IS NULL AND outcome IS NULL) OR (state='completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL AND outcome IS NOT NULL)),
 CONSTRAINT agent_runs_error_contract CHECK((outcome='failed' AND error_code IS NOT NULL) OR (outcome IS DISTINCT FROM 'failed' AND error_code IS NULL)),
 CONSTRAINT agent_runs_chronology CHECK((started_at IS NULL OR started_at>=created_at) AND (completed_at IS NULL OR completed_at>=started_at))
);

CREATE TABLE app.agent_authorized_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), activity_id uuid NOT NULL, run_id uuid NOT NULL, user_id uuid NOT NULL, account_id uuid NOT NULL,
 correlation_id text NOT NULL, causation_id uuid NOT NULL, manager_kind app.agent_work_manager_kind NOT NULL, manager_connection_id uuid, manager_lifecycle_revision integer, manager_legacy_source_id text,
 mode app.agent_invocation_mode NOT NULL, assignment_id uuid NOT NULL, assignment_revision integer NOT NULL, grant_id uuid NOT NULL, grant_revision integer NOT NULL, safety_revision integer NOT NULL,
 kind app.agent_action_kind NOT NULL, target jsonb NOT NULL, authorization_revision integer NOT NULL, idempotency_key text NOT NULL, attempt integer NOT NULL, retry_of_action_id uuid,
 state app.agent_action_state NOT NULL DEFAULT 'authorized', error_code text, authorized_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, provider_reported_at timestamptz, completed_at timestamptz,
 UNIQUE(id,user_id,account_id), UNIQUE(user_id,account_id,idempotency_key),
 CONSTRAINT agent_actions_activity_fk FOREIGN KEY(activity_id,user_id,account_id) REFERENCES app.agent_activities(id,user_id,account_id) ON DELETE RESTRICT,
 CONSTRAINT agent_actions_run_fk FOREIGN KEY(run_id,user_id,account_id) REFERENCES app.agent_runs(id,user_id,account_id) ON DELETE RESTRICT,
 CONSTRAINT agent_actions_retry_fk FOREIGN KEY(retry_of_action_id,user_id,account_id) REFERENCES app.agent_authorized_actions(id,user_id,account_id) ON DELETE RESTRICT,
 CONSTRAINT agent_actions_assignment_revision_fk FOREIGN KEY(assignment_id,assignment_revision,user_id,account_id) REFERENCES app.mailbox_manager_assignment_revisions(assignment_id,revision,user_id,account_id) ON DELETE RESTRICT,
 CONSTRAINT agent_actions_grant_revision_fk FOREIGN KEY(grant_id,grant_revision,user_id,account_id) REFERENCES app.agent_capability_grant_revisions(grant_id,revision,user_id,account_id) ON DELETE RESTRICT,
 CONSTRAINT agent_actions_lifecycle_revision_fk FOREIGN KEY(manager_connection_id,manager_lifecycle_revision,user_id) REFERENCES app.agent_connection_lifecycle_revisions(connection_id,revision,user_id) ON DELETE RESTRICT,
 CONSTRAINT agent_actions_safety_revision_fk FOREIGN KEY(safety_revision) REFERENCES app.agent_safety_ceiling_revisions(revision) ON DELETE RESTRICT,
 CONSTRAINT agent_actions_manager_contract CHECK((manager_kind='agent_connection' AND manager_connection_id IS NOT NULL AND manager_lifecycle_revision IS NOT NULL AND manager_legacy_source_id IS NULL) OR (manager_kind='mastra' AND manager_connection_id IS NULL AND manager_lifecycle_revision IS NULL AND manager_legacy_source_id IS NULL) OR (manager_kind='legacy_mastra' AND manager_connection_id IS NULL AND manager_lifecycle_revision IS NULL AND length(btrim(manager_legacy_source_id))>0)),
 CONSTRAINT agent_actions_attempt_contract CHECK((attempt=1 AND retry_of_action_id IS NULL) OR (attempt>1 AND retry_of_action_id IS NOT NULL)),
 CONSTRAINT agent_actions_revisions_positive CHECK(authorization_revision>0 AND assignment_revision>0 AND grant_revision>0 AND safety_revision>0),
 CONSTRAINT agent_actions_idempotency CHECK(length(btrim(idempotency_key)) BETWEEN 16 AND 200),
 CONSTRAINT agent_actions_target_contract CHECK((kind IN ('archive','recoverable_trash','move','mark_read','mark_unread') AND target ? 'messageId') OR (kind IN ('draft_create','draft_edit','send') AND target ? 'draftId')),
 CONSTRAINT agent_actions_move_target CHECK(kind<>'move' OR target ? 'destinationFolderId'),
 CONSTRAINT agent_actions_state_contract CHECK((state='authorized' AND started_at IS NULL AND provider_reported_at IS NULL AND completed_at IS NULL) OR (state='executing' AND started_at IS NOT NULL AND provider_reported_at IS NULL AND completed_at IS NULL) OR (state='verifying' AND started_at IS NOT NULL AND provider_reported_at IS NOT NULL AND completed_at IS NULL) OR (state IN ('verified','failed','unverifiable','cancelled') AND completed_at IS NOT NULL)),
 CONSTRAINT agent_actions_error_contract CHECK((state='failed' AND error_code IS NOT NULL) OR (state<>'failed' AND error_code IS NULL)),
 CONSTRAINT agent_actions_chronology CHECK((started_at IS NULL OR started_at>=authorized_at) AND (provider_reported_at IS NULL OR provider_reported_at>=started_at) AND (completed_at IS NULL OR completed_at>=COALESCE(started_at,authorized_at)))
);

CREATE TABLE app.agent_action_verifications (
 action_id uuid PRIMARY KEY, user_id uuid NOT NULL, account_id uuid NOT NULL, verifier text NOT NULL,
 provider_mutation_id text, evidence_digest text NOT NULL, observed_at timestamptz NOT NULL,
 CONSTRAINT agent_action_verifications_action_fk FOREIGN KEY(action_id,user_id,account_id) REFERENCES app.agent_authorized_actions(id,user_id,account_id) ON DELETE RESTRICT,
 CONSTRAINT agent_action_verifications_verifier CHECK(verifier='hypermail_provider_readback'),
 CONSTRAINT agent_action_verifications_digest CHECK(evidence_digest ~ '^[a-f0-9]{64}$')
);
CREATE TRIGGER agent_action_verifications_append_only BEFORE UPDATE OR DELETE ON app.agent_action_verifications FOR EACH ROW EXECUTE FUNCTION app.reject_canonical_history_mutation();

CREATE TABLE app.agent_activity_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), activity_id uuid NOT NULL, user_id uuid NOT NULL, account_id uuid NOT NULL,
 sequence integer NOT NULL, correlation_id text NOT NULL, causation_id uuid, occurred_at timestamptz NOT NULL, detail jsonb NOT NULL,
 UNIQUE(activity_id,sequence), CONSTRAINT agent_activity_events_activity_fk FOREIGN KEY(activity_id,user_id,account_id) REFERENCES app.agent_activities(id,user_id,account_id) ON DELETE RESTRICT,
 CONSTRAINT agent_activity_events_sequence_positive CHECK(sequence>0),
 CONSTRAINT agent_activity_events_detail_closed CHECK((detail->>'type') IN ('run_started','run_completed','run_failed','question_asked','question_answered','sensitive_read_summary','authorization_denied','action_authorized','action_started','action_provider_reported','action_verified','action_failed','action_unverifiable','no_action','safety_event','external_drift'))
);
CREATE TRIGGER agent_activity_events_append_only BEFORE UPDATE OR DELETE ON app.agent_activity_events FOR EACH ROW EXECUTE FUNCTION app.reject_canonical_history_mutation();

CREATE FUNCTION app.enforce_agent_run_insert() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE expected_sequence integer; BEGIN
 PERFORM 1 FROM app.agent_activities WHERE id=NEW.activity_id AND user_id=NEW.user_id AND account_id=NEW.account_id FOR UPDATE;
 SELECT COALESCE(max(sequence),0)+1 INTO expected_sequence FROM app.agent_runs WHERE activity_id=NEW.activity_id;
 IF NEW.sequence<>expected_sequence THEN RAISE EXCEPTION 'Agent Run sequence must be %', expected_sequence; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER agent_runs_contiguous_sequence BEFORE INSERT ON app.agent_runs FOR EACH ROW EXECUTE FUNCTION app.enforce_agent_run_insert();

CREATE FUNCTION app.enforce_agent_event_insert() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE prior_sequence integer; prior_time timestamptz; BEGIN
 PERFORM 1 FROM app.agent_activities WHERE id=NEW.activity_id AND user_id=NEW.user_id AND account_id=NEW.account_id FOR UPDATE;
 SELECT sequence,occurred_at INTO prior_sequence,prior_time FROM app.agent_activity_events WHERE activity_id=NEW.activity_id ORDER BY sequence DESC LIMIT 1;
 IF NEW.sequence<>COALESCE(prior_sequence,0)+1 OR (prior_time IS NOT NULL AND NEW.occurred_at<prior_time) THEN RAISE EXCEPTION 'Agent Activity Event sequence or chronology is invalid'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER agent_activity_events_contiguous_sequence BEFORE INSERT ON app.agent_activity_events FOR EACH ROW EXECUTE FUNCTION app.enforce_agent_event_insert();

CREATE FUNCTION app.enforce_agent_action_insert() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE run_row app.agent_runs%ROWTYPE; prior_row app.agent_authorized_actions%ROWTYPE; BEGIN
 SELECT * INTO run_row FROM app.agent_runs WHERE id=NEW.run_id AND user_id=NEW.user_id AND account_id=NEW.account_id FOR SHARE;
 IF run_row.id IS NULL OR (NEW.activity_id,NEW.user_id,NEW.account_id,NEW.manager_kind,NEW.manager_connection_id,NEW.manager_legacy_source_id,NEW.manager_lifecycle_revision,NEW.mode,NEW.assignment_id,NEW.assignment_revision,NEW.grant_id,NEW.grant_revision,NEW.safety_revision)
   IS DISTINCT FROM (run_row.activity_id,run_row.user_id,run_row.account_id,run_row.manager_kind,run_row.manager_connection_id,run_row.manager_legacy_source_id,run_row.manager_lifecycle_revision,run_row.mode,run_row.assignment_id,run_row.assignment_revision,run_row.grant_id,run_row.grant_revision,run_row.safety_revision)
 THEN RAISE EXCEPTION 'Agent Action authority must match its frozen Run'; END IF;
 IF NEW.retry_of_action_id IS NOT NULL THEN
   SELECT * INTO prior_row FROM app.agent_authorized_actions WHERE id=NEW.retry_of_action_id AND user_id=NEW.user_id AND account_id=NEW.account_id FOR SHARE;
   IF prior_row.id IS NULL OR prior_row.state NOT IN ('failed','unverifiable') OR NEW.attempt<>prior_row.attempt+1 OR NEW.activity_id<>prior_row.activity_id OR NEW.kind<>prior_row.kind OR NEW.target<>prior_row.target
   THEN RAISE EXCEPTION 'Agent Action retry lineage is invalid'; END IF;
 END IF;
 RETURN NEW; END $$;
CREATE TRIGGER agent_actions_frozen_authority_and_retry BEFORE INSERT ON app.agent_authorized_actions FOR EACH ROW EXECUTE FUNCTION app.enforce_agent_action_insert();

CREATE FUNCTION app.enforce_agent_activity_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Agent Activities cannot be deleted'; END IF;
 IF NEW.id<>OLD.id OR (NEW.user_id,NEW.account_id,NEW.kind,NEW.source_message_id,NEW.correlation_id,NEW.causation_id,NEW.created_at) IS DISTINCT FROM (OLD.user_id,OLD.account_id,OLD.kind,OLD.source_message_id,OLD.correlation_id,OLD.causation_id,OLD.created_at) THEN RAISE EXCEPTION 'agent Activity identity is immutable'; END IF;
 IF NEW.revision<>OLD.revision+1 OR NOT ((OLD.state='open' AND NEW.state IN ('waiting_for_answer','resolved','attention_required')) OR (OLD.state='waiting_for_answer' AND NEW.state IN ('open','attention_required')) OR (OLD.state='resolved' AND NEW.state='acknowledged') OR (OLD.state='attention_required' AND NEW.state IN ('open','resolved','acknowledged'))) THEN RAISE EXCEPTION 'illegal Agent Activity transition'; END IF; RETURN NEW; END $$;
CREATE TRIGGER agent_activities_legal_transition BEFORE UPDATE OR DELETE ON app.agent_activities FOR EACH ROW EXECUTE FUNCTION app.enforce_agent_activity_transition();
CREATE FUNCTION app.enforce_agent_run_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Agent Runs are immutable history'; END IF;
 IF (NEW.id,NEW.activity_id,NEW.user_id,NEW.account_id,NEW.sequence,NEW.manager_kind,NEW.manager_connection_id,NEW.manager_legacy_source_id,NEW.manager_lifecycle_revision,NEW.assignment_id,NEW.assignment_revision,NEW.grant_id,NEW.grant_revision,NEW.safety_revision,NEW.mode,NEW.trigger,NEW.input_digest,NEW.correlation_id,NEW.causation_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.activity_id,OLD.user_id,OLD.account_id,OLD.sequence,OLD.manager_kind,OLD.manager_connection_id,OLD.manager_legacy_source_id,OLD.manager_lifecycle_revision,OLD.assignment_id,OLD.assignment_revision,OLD.grant_id,OLD.grant_revision,OLD.safety_revision,OLD.mode,OLD.trigger,OLD.input_digest,OLD.correlation_id,OLD.causation_id,OLD.created_at) THEN RAISE EXCEPTION 'Agent Run identity is immutable'; END IF;
 IF OLD.state='completed' OR NOT ((OLD.state='created' AND NEW.state='running') OR (OLD.state='running' AND NEW.state='completed' AND NEW.started_at=OLD.started_at)) THEN RAISE EXCEPTION 'illegal Agent Run transition'; END IF; RETURN NEW; END $$;
CREATE TRIGGER agent_runs_legal_transition BEFORE UPDATE OR DELETE ON app.agent_runs FOR EACH ROW EXECUTE FUNCTION app.enforce_agent_run_transition();
CREATE FUNCTION app.enforce_agent_action_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Agent Actions are immutable history'; END IF;
 IF (NEW.id,NEW.activity_id,NEW.run_id,NEW.user_id,NEW.account_id,NEW.correlation_id,NEW.causation_id,NEW.manager_kind,NEW.manager_connection_id,NEW.manager_lifecycle_revision,NEW.manager_legacy_source_id,NEW.mode,NEW.assignment_id,NEW.assignment_revision,NEW.grant_id,NEW.grant_revision,NEW.safety_revision,NEW.kind,NEW.target,NEW.authorization_revision,NEW.idempotency_key,NEW.attempt,NEW.retry_of_action_id,NEW.authorized_at) IS DISTINCT FROM (OLD.id,OLD.activity_id,OLD.run_id,OLD.user_id,OLD.account_id,OLD.correlation_id,OLD.causation_id,OLD.manager_kind,OLD.manager_connection_id,OLD.manager_lifecycle_revision,OLD.manager_legacy_source_id,OLD.mode,OLD.assignment_id,OLD.assignment_revision,OLD.grant_id,OLD.grant_revision,OLD.safety_revision,OLD.kind,OLD.target,OLD.authorization_revision,OLD.idempotency_key,OLD.attempt,OLD.retry_of_action_id,OLD.authorized_at) THEN RAISE EXCEPTION 'Agent Action identity is immutable'; END IF;
 IF OLD.state IN ('verified','failed','unverifiable','cancelled') OR NOT ((OLD.state='authorized' AND NEW.state IN ('executing','failed','unverifiable','cancelled')) OR (OLD.state='executing' AND NEW.state IN ('verifying','verified','failed','unverifiable','cancelled') AND NEW.started_at=OLD.started_at AND (NEW.state<>'verified' OR NEW.provider_reported_at IS NULL)) OR (OLD.state='verifying' AND NEW.state IN ('verified','failed','unverifiable','cancelled') AND NEW.started_at=OLD.started_at AND NEW.provider_reported_at=OLD.provider_reported_at)) THEN RAISE EXCEPTION 'illegal Agent Action transition'; END IF; RETURN NEW; END $$;
CREATE TRIGGER agent_actions_legal_transition BEFORE UPDATE OR DELETE ON app.agent_authorized_actions FOR EACH ROW EXECUTE FUNCTION app.enforce_agent_action_transition();

CREATE FUNCTION app.enforce_verified_action_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE aid uuid; action_row app.agent_authorized_actions%ROWTYPE; evidence_row app.agent_action_verifications%ROWTYPE; BEGIN IF TG_TABLE_NAME='agent_authorized_actions' THEN aid:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END; ELSE aid:=CASE WHEN TG_OP='DELETE' THEN OLD.action_id ELSE NEW.action_id END; END IF; SELECT * INTO action_row FROM app.agent_authorized_actions WHERE id=aid; SELECT * INTO evidence_row FROM app.agent_action_verifications WHERE action_id=aid; IF (action_row.state='verified') IS DISTINCT FROM (evidence_row.action_id IS NOT NULL) THEN RAISE EXCEPTION 'verified Action and provider readback evidence must exist bidirectionally'; END IF; IF evidence_row.action_id IS NOT NULL AND (evidence_row.observed_at < action_row.provider_reported_at OR evidence_row.user_id<>action_row.user_id OR evidence_row.account_id<>action_row.account_id) THEN RAISE EXCEPTION 'provider readback evidence does not match Action chronology or tenant'; END IF; RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER agent_actions_require_evidence AFTER INSERT OR UPDATE ON app.agent_authorized_actions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.enforce_verified_action_evidence();
CREATE CONSTRAINT TRIGGER agent_evidence_requires_verified_action AFTER INSERT OR UPDATE OR DELETE ON app.agent_action_verifications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.enforce_verified_action_evidence();
