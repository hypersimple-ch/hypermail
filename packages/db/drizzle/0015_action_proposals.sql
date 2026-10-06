-- Historical decisions remain readable, never upgraded into executable plans.
ALTER TABLE app.decisions ADD COLUMN schema_version integer NOT NULL DEFAULT 1,
 ADD COLUMN run_id uuid, ADD COLUMN user_id uuid, ADD COLUMN account_id uuid,
 ADD COLUMN evidence_snapshot jsonb NOT NULL DEFAULT '[]';
UPDATE app.decisions d SET account_id=a.account_id,user_id=ua.user_id FROM app.activities a JOIN app.user_accounts ua ON ua.account_id=a.account_id WHERE a.id=d.activity_id;
ALTER TABLE app.decisions ALTER COLUMN user_id SET NOT NULL, ALTER COLUMN account_id SET NOT NULL, ALTER COLUMN schema_version SET DEFAULT 2;
CREATE UNIQUE INDEX decisions_scope_unique ON app.decisions(id,user_id,account_id,activity_id,run_id);
CREATE UNIQUE INDEX agent_runs_scope_unique ON app.agent_runs(id,user_id,account_id,activity_id);
ALTER TABLE app.decisions ADD CONSTRAINT decisions_version CHECK(schema_version IN (1,2) AND (schema_version=1 OR (run_id IS NOT NULL AND output->>'schemaVersion'='2'))),
 ADD CONSTRAINT decisions_owned_mailbox_fk FOREIGN KEY(user_id,account_id) REFERENCES app.user_accounts(user_id,account_id),
 ADD CONSTRAINT decisions_run_scope_fk FOREIGN KEY(run_id,user_id,account_id,activity_id) REFERENCES app.agent_runs(id,user_id,account_id,activity_id),
 ADD CONSTRAINT decisions_evidence_shape CHECK(jsonb_typeof(evidence_snapshot)='array' AND jsonb_array_length(evidence_snapshot)<=41);
CREATE TRIGGER decisions_append_only BEFORE UPDATE OR DELETE ON app.decisions FOR EACH ROW EXECUTE FUNCTION app.reject_canonical_history_mutation();

CREATE FUNCTION app.utf16_length(value text) RETURNS integer LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT length(value)+length(regexp_replace(value,U&'[^\+010000-\+10FFFF]','','g'))
$$;
CREATE FUNCTION app.valid_action_payload(p jsonb,k text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE r jsonb;
BEGIN
 IF jsonb_typeof(p)<>'object' OR p->>'kind' IS DISTINCT FROM k OR jsonb_typeof(p->'target') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE x NOT IN ('kind','target','reason','key','confidence','evidenceIds','dependsOn','draft','expectedVersion')) OR jsonb_typeof(p->'reason') IS DISTINCT FROM 'string' OR app.utf16_length(p->>'reason') NOT BETWEEN 1 AND 2000 OR length(btrim(p->>'reason'))=0 THEN RETURN false; END IF;
 IF (k NOT IN ('draft_create','draft_edit') AND p ? 'draft') OR (k<>'draft_edit' AND p ? 'expectedVersion') THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p->'target') x WHERE (k='draft_edit' AND x NOT IN ('accountId','draftId')) OR (k='move' AND x NOT IN ('accountId','messageId','destinationFolderId')) OR (k NOT IN ('draft_edit','move') AND x NOT IN ('accountId','messageId'))) THEN RETURN false; END IF;
 IF k NOT IN ('archive','move','recoverable_trash','draft_create','draft_edit') THEN RETURN false; END IF;
 IF coalesce(p->'target'->>'accountId','') !~ '^[0-9a-fA-F-]{36}$' THEN RETURN false; END IF;
 IF k='draft_edit' THEN
  IF coalesce(p->'target'->>'draftId','') !~ '^[0-9a-fA-F-]{36}$' OR coalesce(p->>'expectedVersion','') !~ '^[1-9][0-9]*$' THEN RETURN false; END IF;
 ELSE IF coalesce(p->'target'->>'messageId','') !~ '^[0-9a-fA-F-]{36}$' THEN RETURN false; END IF; END IF;
 IF k='move' AND coalesce(p->'target'->>'destinationFolderId','') !~ '^[0-9a-fA-F-]{36}$' THEN RETURN false; END IF;
 IF k IN ('draft_create','draft_edit') THEN
  IF jsonb_typeof(p->'draft') IS DISTINCT FROM 'object' OR coalesce(p->'draft'->>'bodyFormat','') NOT IN ('markdown','html')
   OR jsonb_typeof(p->'draft'->'body') IS DISTINCT FROM 'string' OR app.utf16_length(p->'draft'->>'body')>2000000
   OR jsonb_typeof(p->'draft'->'subject') IS DISTINCT FROM 'string' OR app.utf16_length(p->'draft'->>'subject')>998
   OR jsonb_typeof(p->'draft'->'recipients') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p->'draft') x WHERE x NOT IN ('recipients','subject','body','bodyFormat')) THEN RETURN false; END IF;
  IF jsonb_array_length(p->'draft'->'recipients') NOT BETWEEN 1 AND 100 THEN RETURN false; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p->'draft'->'recipients') LOOP
   IF coalesce(r->>'kind','') NOT IN ('to','cc','bcc') OR coalesce(r->>'address','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN RETURN false; END IF;
   IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(r) x WHERE x NOT IN ('kind','address')) THEN RETURN false; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'draft'->'recipients') x WHERE x->>'kind'='to') OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'draft'->'recipients') x GROUP BY lower(x->>'address') HAVING count(*)>1) THEN RETURN false; END IF;
 END IF;
 RETURN true;
END $$;
CREATE TABLE app.agent_action_proposals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,account_id uuid NOT NULL,activity_id uuid NOT NULL,run_id uuid NOT NULL,decision_id uuid NOT NULL,
 action_key text NOT NULL,origin text NOT NULL,kind text NOT NULL,payload jsonb NOT NULL,confidence double precision,threshold double precision NOT NULL,evidence_snapshot jsonb NOT NULL,
 revision integer NOT NULL DEFAULT 1,state text NOT NULL,supersedes_proposal_id uuid,authorized_action_id uuid UNIQUE,error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(decision_id,action_key),UNIQUE(id,user_id,account_id),UNIQUE(id,user_id,account_id,activity_id),
 FOREIGN KEY(user_id,account_id) REFERENCES app.user_accounts(user_id,account_id),
 FOREIGN KEY(activity_id,user_id,account_id) REFERENCES app.agent_activities(id,user_id,account_id),
 FOREIGN KEY(run_id,user_id,account_id,activity_id) REFERENCES app.agent_runs(id,user_id,account_id,activity_id),
 FOREIGN KEY(decision_id,user_id,account_id,activity_id,run_id) REFERENCES app.decisions(id,user_id,account_id,activity_id,run_id),
 FOREIGN KEY(supersedes_proposal_id,user_id,account_id,activity_id) REFERENCES app.agent_action_proposals(id,user_id,account_id,activity_id),
 FOREIGN KEY(authorized_action_id,user_id,account_id) REFERENCES app.agent_authorized_actions(id,user_id,account_id),
 CHECK(action_key ~ '^[a-z][a-z0-9_]{0,63}$'),CHECK(origin IN ('model','owner')),
 CHECK((origin='model' AND confidence IS NOT NULL AND confidence>=0 AND confidence<=1) OR (origin='owner' AND confidence IS NULL)),
 CHECK(threshold>=0 AND threshold<=1),CHECK(revision>0),CHECK(state IN ('waiting_review','ready','authorized','rejected','superseded','blocked')),
 CHECK(app.valid_action_payload(payload,kind)),CHECK(payload->'target'->>'accountId'=account_id::text),
 CHECK(jsonb_typeof(evidence_snapshot)='array' AND jsonb_array_length(evidence_snapshot)<=41),CHECK((state='authorized')=(authorized_action_id IS NOT NULL)),
 CHECK((origin='model' AND supersedes_proposal_id IS NULL) OR (origin='owner' AND supersedes_proposal_id IS NOT NULL))
);
CREATE INDEX agent_action_proposals_ready_idx ON app.agent_action_proposals(created_at,id) WHERE state='ready';
CREATE TABLE app.agent_proposal_dependencies (
 proposal_id uuid NOT NULL,depends_on_id uuid NOT NULL,user_id uuid NOT NULL,account_id uuid NOT NULL,activity_id uuid NOT NULL,
 PRIMARY KEY(proposal_id,depends_on_id),CHECK(proposal_id<>depends_on_id),
 FOREIGN KEY(proposal_id,user_id,account_id,activity_id) REFERENCES app.agent_action_proposals(id,user_id,account_id,activity_id),
 FOREIGN KEY(depends_on_id,user_id,account_id,activity_id) REFERENCES app.agent_action_proposals(id,user_id,account_id,activity_id)
);
CREATE TABLE app.agent_action_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),proposal_id uuid NOT NULL UNIQUE,user_id uuid NOT NULL,account_id uuid NOT NULL,
 decision text NOT NULL,idempotency_key text NOT NULL,request_digest text NOT NULL,reason text,correction jsonb,successor_proposal_id uuid,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,idempotency_key),FOREIGN KEY(proposal_id,user_id,account_id) REFERENCES app.agent_action_proposals(id,user_id,account_id),
 FOREIGN KEY(successor_proposal_id,user_id,account_id) REFERENCES app.agent_action_proposals(id,user_id,account_id),
 CHECK(decision IN ('approve','reject','correct')),CHECK(length(idempotency_key) BETWEEN 1 AND 200),CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 CHECK(reason IS NULL OR length(reason)<=2000),CHECK((decision='correct' AND correction IS NOT NULL AND successor_proposal_id IS NOT NULL AND app.valid_action_payload(correction,correction->>'kind')) OR (decision<>'correct' AND correction IS NULL AND successor_proposal_id IS NULL))
);
CREATE TRIGGER agent_action_reviews_append_only BEFORE UPDATE OR DELETE ON app.agent_action_reviews FOR EACH ROW EXECUTE FUNCTION app.reject_canonical_history_mutation();
CREATE FUNCTION app.guard_action_proposal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'proposals are immutable history'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','authorized_action_id','revision','updated_at','error_code']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','authorized_action_id','revision','updated_at','error_code']) OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'proposal identity or revision is immutable'; END IF;
 IF OLD.state NOT IN ('waiting_review','ready') OR NOT ((OLD.state='waiting_review' AND NEW.state IN ('ready','rejected','superseded','blocked')) OR (OLD.state='ready' AND NEW.state IN ('authorized','blocked','superseded'))) THEN RAISE EXCEPTION 'invalid proposal transition'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER action_proposal_guard BEFORE UPDATE OR DELETE ON app.agent_action_proposals FOR EACH ROW EXECUTE FUNCTION app.guard_action_proposal();
CREATE FUNCTION app.guard_proposal_graph() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE aid uuid; BEGIN
 aid:=COALESCE(NEW.activity_id,OLD.activity_id);
 PERFORM 1 FROM app.agent_activities WHERE id=aid FOR UPDATE;
 IF EXISTS(WITH RECURSIVE walk(root,node,path,cycle) AS (
  SELECT proposal_id,depends_on_id,ARRAY[proposal_id,depends_on_id],proposal_id=depends_on_id FROM app.agent_proposal_dependencies WHERE activity_id=aid
  UNION ALL SELECT w.root,d.depends_on_id,w.path||d.depends_on_id,d.depends_on_id=ANY(w.path) FROM walk w JOIN app.agent_proposal_dependencies d ON d.proposal_id=w.node WHERE NOT w.cycle
 ) SELECT 1 FROM walk WHERE cycle) OR EXISTS(SELECT 1 FROM app.agent_proposal_dependencies WHERE activity_id=aid GROUP BY proposal_id HAVING count(*)>4) THEN RAISE EXCEPTION 'invalid proposal dependency graph'; END IF;
 RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER proposal_graph_guard AFTER INSERT OR UPDATE OR DELETE ON app.agent_proposal_dependencies DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.guard_proposal_graph();

ALTER TABLE app.agent_authorized_actions DROP CONSTRAINT agent_actions_target_contract;
ALTER TABLE app.agent_authorized_actions ADD CONSTRAINT agent_actions_target_contract CHECK(
 (kind IN ('archive','recoverable_trash','move','mark_read','mark_unread') AND target ? 'messageId')
 OR (kind='draft_create' AND (target ? 'draftId' OR target ? 'requestId'))
 OR (kind IN ('draft_edit','send') AND target ? 'draftId'));
ALTER TABLE app.agent_authorized_actions DROP CONSTRAINT agent_actions_error_contract;
ALTER TABLE app.agent_authorized_actions ADD CONSTRAINT agent_actions_error_contract CHECK(
 (state='failed' AND error_code IS NOT NULL) OR state='cancelled' OR (state NOT IN ('failed','cancelled') AND error_code IS NULL));

-- Cancel only unstarted legacy work. Already executing/verifying work must use readback only.
UPDATE app.agent_authorized_actions a SET state='cancelled',error_code='DECISION_SCHEMA_UPGRADE_REQUIRED',completed_at=now() WHERE state='authorized' AND EXISTS(SELECT 1 FROM app.decisions d WHERE d.activity_id=a.activity_id AND d.schema_version=1);
UPDATE app.actions a SET state='failed',error_code='DECISION_SCHEMA_UPGRADE_REQUIRED',finished_at=now(),updated_at=now() WHERE state='planned' AND EXISTS(SELECT 1 FROM app.decisions d WHERE d.id=a.decision_id AND d.schema_version=1);
UPDATE app.activities a SET state='failed',last_error_code='DECISION_SCHEMA_UPGRADE_REQUIRED',handled_at=NULL,version=version+1,updated_at=now() WHERE EXISTS(SELECT 1 FROM app.actions x WHERE x.activity_id=a.id AND x.error_code='DECISION_SCHEMA_UPGRADE_REQUIRED');
UPDATE app.agent_activities a SET state='attention_required',revision=revision+1,updated_at=now() WHERE state IN ('open','waiting_for_answer') AND EXISTS(SELECT 1 FROM app.agent_authorized_actions x WHERE x.activity_id=a.id AND x.error_code='DECISION_SCHEMA_UPGRADE_REQUIRED');
CREATE FUNCTION app.fence_legacy_decision_action() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.state='executing' AND OLD.state='authorized' AND EXISTS(SELECT 1 FROM app.decisions d WHERE d.activity_id=NEW.activity_id AND d.schema_version=1 AND (d.run_id=NEW.run_id OR d.run_id IS NULL)) THEN RAISE EXCEPTION 'DECISION_SCHEMA_UPGRADE_REQUIRED'; END IF; RETURN NEW; END $$;
CREATE TRIGGER agent_action_schema_fence BEFORE UPDATE ON app.agent_authorized_actions FOR EACH ROW EXECUTE FUNCTION app.fence_legacy_decision_action();
ALTER TABLE app.agent_activity_events DROP CONSTRAINT agent_activity_events_detail_closed;
ALTER TABLE app.agent_activity_events ADD CONSTRAINT agent_activity_events_detail_closed CHECK((detail->>'type') IN ('run_started','run_completed','run_failed','question_asked','question_answered','sensitive_read_summary','authorization_denied','action_authorized','action_started','action_provider_reported','action_verified','action_failed','action_unverifiable','no_action','safety_event','external_drift','send_approval_requested','send_approval_begun','send_rejected','send_approved','send_failed','send_unverifiable','action_proposed','action_reviewed','action_blocked'));

CREATE FUNCTION app.validate_proposal_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_message uuid; target_draft uuid;
BEGIN
 PERFORM 1 FROM app.agent_activities WHERE id=NEW.activity_id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM app.decisions d JOIN app.agent_runs r ON r.id=d.run_id WHERE d.id=NEW.decision_id AND d.schema_version=2 AND r.state='completed' AND r.outcome='action_requests_emitted') THEN RAISE EXCEPTION 'proposal requires completed v2 decision Run'; END IF;
 IF NEW.origin='model' AND (SELECT count(*) FROM app.agent_action_proposals WHERE decision_id=NEW.decision_id AND origin='model')>=5 THEN RAISE EXCEPTION 'at most five initial actions'; END IF;
 IF NEW.kind='draft_edit' THEN
  target_draft:=(NEW.payload->'target'->>'draftId')::uuid;
  IF NOT EXISTS(SELECT 1 FROM app.drafts WHERE id=target_draft AND account_id=NEW.account_id) THEN RAISE EXCEPTION 'draft outside proposal scope'; END IF;
 ELSE
  target_message:=(NEW.payload->'target'->>'messageId')::uuid;
  IF NOT EXISTS(SELECT 1 FROM app.messages WHERE id=target_message AND account_id=NEW.account_id) OR NOT EXISTS(SELECT 1 FROM app.agent_activities WHERE id=NEW.activity_id AND source_message_id=target_message) THEN RAISE EXCEPTION 'message outside proposal context'; END IF;
 END IF;
 IF NEW.kind='move' AND NOT EXISTS(SELECT 1 FROM app.folders WHERE id=(NEW.payload->'target'->>'destinationFolderId')::uuid AND account_id=NEW.account_id AND selectable) THEN RAISE EXCEPTION 'destination absent or outside mailbox'; END IF;
 IF NEW.origin='model' AND NEW.kind IN ('archive','move','recoverable_trash') AND EXISTS(SELECT 1 FROM app.agent_action_proposals WHERE decision_id=NEW.decision_id AND origin='model' AND kind IN ('archive','move','recoverable_trash') AND payload->'target'->>'messageId'=target_message::text) THEN RAISE EXCEPTION 'conflicting classification actions'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER proposal_context_guard BEFORE INSERT ON app.agent_action_proposals FOR EACH ROW EXECUTE FUNCTION app.validate_proposal_insert();

CREATE OR REPLACE FUNCTION app.enforce_agent_activity_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Agent Activities cannot be deleted'; END IF;
 IF (NEW.id,NEW.user_id,NEW.account_id,NEW.kind,NEW.source_message_id,NEW.correlation_id,NEW.causation_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.account_id,OLD.kind,OLD.source_message_id,OLD.correlation_id,OLD.causation_id,OLD.created_at) THEN RAISE EXCEPTION 'Agent Activity identity is immutable'; END IF;
 IF NEW.revision<>OLD.revision+1 OR NOT ((OLD.state='open' AND NEW.state IN ('waiting_for_answer','resolved','attention_required')) OR (OLD.state='waiting_for_answer' AND NEW.state IN ('open','resolved','attention_required')) OR (OLD.state='resolved' AND NEW.state='acknowledged') OR (OLD.state='attention_required' AND NEW.state IN ('open','resolved','acknowledged')) OR NEW.state=OLD.state) THEN RAISE EXCEPTION 'illegal Agent Activity transition'; END IF;
 IF NEW.state IN ('resolved','acknowledged') AND (
  EXISTS(SELECT 1 FROM app.agent_action_proposals p LEFT JOIN app.agent_authorized_actions a ON a.id=p.authorized_action_id WHERE p.activity_id=NEW.id AND (p.state IN ('waiting_review','ready','blocked') OR (p.state='authorized' AND a.state IS DISTINCT FROM 'verified')))
  OR EXISTS(SELECT 1 FROM app.agent_authorized_actions WHERE activity_id=NEW.id AND state<>'verified')
  OR EXISTS(SELECT 1 FROM app.agent_runs WHERE activity_id=NEW.id AND state<>'completed')
  OR EXISTS(SELECT 1 FROM app.questions WHERE activity_id=NEW.id AND state='open')
  OR EXISTS(SELECT 1 FROM app.agent_jobs WHERE activity_id=NEW.id AND state IN ('pending','running','suspended','failed'))
  OR EXISTS(SELECT 1 FROM app.actions WHERE activity_id=NEW.id AND state<>'succeeded')
 ) THEN RAISE EXCEPTION 'Activity still has unresolved work'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION app.fence_legacy_projection_action() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.state='executing' AND OLD.state='planned' AND EXISTS(SELECT 1 FROM app.decisions WHERE id=NEW.decision_id AND schema_version=1) THEN RAISE EXCEPTION 'DECISION_SCHEMA_UPGRADE_REQUIRED'; END IF; RETURN NEW; END $$;
CREATE TRIGGER legacy_action_schema_fence BEFORE UPDATE ON app.actions FOR EACH ROW EXECUTE FUNCTION app.fence_legacy_projection_action();

ALTER TABLE app.agent_action_proposals ADD CONSTRAINT proposal_model_snapshot CHECK(origin<>'model' OR (
 payload->>'key'=action_key AND jsonb_typeof(payload->'reason')='string' AND app.utf16_length(payload->>'reason') BETWEEN 1 AND 2000
 AND jsonb_typeof(payload->'evidenceIds')='array' AND jsonb_array_length(payload->'evidenceIds')<=20
 AND jsonb_typeof(payload->'dependsOn')='array' AND jsonb_array_length(payload->'dependsOn')<=4
 AND (kind NOT IN ('draft_create','draft_edit') OR payload->'draft'->>'bodyFormat'='markdown')
) IS TRUE);
ALTER TABLE app.decisions ADD CONSTRAINT decisions_v2_output_required CHECK(schema_version=1 OR coalesce(output->>'schemaVersion','')='2');
CREATE OR REPLACE FUNCTION app.fence_legacy_decision_action() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.state='executing' AND OLD.state='authorized' AND EXISTS(SELECT 1 FROM app.decisions d WHERE d.activity_id=NEW.activity_id AND d.schema_version=1 AND (d.run_id=NEW.run_id OR (d.run_id IS NULL AND NOT EXISTS(SELECT 1 FROM app.decisions v2 WHERE v2.run_id=NEW.run_id AND v2.schema_version=2)))) THEN RAISE EXCEPTION 'DECISION_SCHEMA_UPGRADE_REQUIRED'; END IF; RETURN NEW; END $$;
CREATE FUNCTION app.lock_proposal_dependency_graph() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM 1 FROM app.agent_activities WHERE id=COALESCE(NEW.activity_id,OLD.activity_id) FOR UPDATE;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF EXISTS(SELECT 1 FROM app.agent_action_proposals WHERE id=NEW.proposal_id AND state='authorized') THEN RAISE EXCEPTION 'authorized dependencies are frozen'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER proposal_dependency_lock BEFORE INSERT OR UPDATE OR DELETE ON app.agent_proposal_dependencies FOR EACH ROW EXECUTE FUNCTION app.lock_proposal_dependency_graph();
CREATE FUNCTION app.require_proposal_authorization() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.state='authorized' THEN
  IF NOT EXISTS(SELECT 1 FROM app.agent_authorized_actions a WHERE a.id=NEW.authorized_action_id AND a.activity_id=NEW.activity_id AND a.run_id=NEW.run_id AND a.kind::text=NEW.kind) THEN RAISE EXCEPTION 'proposal action must match frozen identity'; END IF;
  IF NEW.origin='model' AND NEW.confidence<NEW.threshold AND NOT EXISTS(SELECT 1 FROM app.agent_action_reviews WHERE proposal_id=NEW.id AND decision='approve') THEN RAISE EXCEPTION 'proposal requires owner approval'; END IF;
  IF NEW.origin='owner' AND NOT EXISTS(SELECT 1 FROM app.agent_action_reviews WHERE proposal_id=NEW.supersedes_proposal_id AND successor_proposal_id=NEW.id AND decision='correct') THEN RAISE EXCEPTION 'owner correction must have append-only review'; END IF;
  IF EXISTS(SELECT 1 FROM app.agent_proposal_dependencies d JOIN app.agent_action_proposals p ON p.id=d.depends_on_id LEFT JOIN app.agent_authorized_actions a ON a.id=p.authorized_action_id WHERE d.proposal_id=NEW.id AND a.state IS DISTINCT FROM 'verified') THEN RAISE EXCEPTION 'proposal dependencies must be verified'; END IF;
 END IF; RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER proposal_authorization_review AFTER INSERT OR UPDATE ON app.agent_action_proposals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.require_proposal_authorization();
