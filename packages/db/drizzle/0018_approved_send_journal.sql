CREATE UNIQUE INDEX send_approvals_owner_identity ON app.send_approvals(id,user_id);
CREATE UNIQUE INDEX recovery_tokens_owner_identity ON app.recovery_tokens(id,user_id);
CREATE TABLE app.approved_send_submissions (
 approval_id uuid PRIMARY KEY,user_id uuid NOT NULL,account_id uuid NOT NULL,source_kind text NOT NULL,source_id uuid NOT NULL,source_version integer NOT NULL,idempotency_key text NOT NULL UNIQUE,request_digest text NOT NULL,payload jsonb,
 state text NOT NULL DEFAULT 'pending',provider_message_id text,provider_reference_type text NOT NULL DEFAULT 'none',provider_type app.provider NOT NULL,
 started_at timestamptz,finished_at timestamptz,last_checked_at timestamptz,error_code text,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(approval_id,user_id,account_id),FOREIGN KEY(approval_id,user_id) REFERENCES app.send_approvals(id,user_id),FOREIGN KEY(user_id,account_id) REFERENCES app.user_accounts(user_id,account_id),
 CHECK(source_kind IN ('draft','send_request')),CHECK(source_version>0 AND version>0),CHECK(length(idempotency_key) BETWEEN 1 AND 200),CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 CHECK(state IN ('pending','dispatching','reported','verified','rejected','unknown')),CHECK(provider_reference_type IN ('native_id','internet_message_id','none')),
 CHECK((provider_reference_type='none' AND provider_message_id IS NULL) OR (provider_reference_type<>'none' AND provider_message_id IS NOT NULL AND length(provider_message_id)>0)),
 CHECK(payload IS NULL OR ((jsonb_typeof(payload)='object' AND jsonb_typeof(payload->'body')='string' AND app.utf16_length(payload->>'body')<=2000000 AND jsonb_typeof(payload->'subject')='string' AND app.utf16_length(payload->>'subject')<=998 AND payload->>'bodyFormat' IN ('markdown','html') AND jsonb_typeof(payload->'recipients')='array' AND jsonb_array_length(payload->'recipients') BETWEEN 1 AND 100) IS TRUE)),
 CHECK((state='pending' AND started_at IS NULL) OR (state='rejected' AND started_at IS NULL AND error_code IS NOT DISTINCT FROM 'APPROVAL_EXPIRED_UNDISPATCHED' AND finished_at IS NOT NULL) OR (state<>'pending' AND started_at IS NOT NULL))
);
CREATE INDEX approved_send_submissions_reconcile ON app.approved_send_submissions(state,last_checked_at) WHERE state IN ('dispatching','reported','unknown');
CREATE FUNCTION app.guard_send_submission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM app.send_approvals a JOIN app.drafts d ON d.id=a.draft_id WHERE a.id=NEW.approval_id AND a.user_id=NEW.user_id AND d.account_id=NEW.account_id AND a.draft_version=NEW.source_version AND ((NEW.source_kind='draft' AND NEW.source_id=d.id AND a.public_send_request_id IS NULL) OR (NEW.source_kind='send_request' AND NEW.source_id=a.public_send_request_id))) OR NEW.payload IS NULL OR NEW.state<>'pending' THEN RAISE EXCEPTION 'submission must match approved owner snapshot'; END IF; RETURN NEW;
 END IF;
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['state','provider_message_id','provider_reference_type','started_at','finished_at','last_checked_at','error_code','version','updated_at','payload']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','provider_message_id','provider_reference_type','started_at','finished_at','last_checked_at','error_code','version','updated_at','payload']) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'submission identity or version immutable'; END IF;
 IF NEW.payload IS DISTINCT FROM OLD.payload AND NOT (OLD.payload IS NOT NULL AND NEW.payload IS NULL AND OLD.state NOT IN ('pending','dispatching')) THEN RAISE EXCEPTION 'approved snapshot immutable'; END IF;
 IF NOT ((OLD.state='pending' AND NEW.state='dispatching') OR (OLD.state='pending' AND NEW.state='rejected' AND OLD.started_at IS NULL AND NEW.started_at IS NULL AND NEW.error_code IS NOT DISTINCT FROM 'APPROVAL_EXPIRED_UNDISPATCHED' AND NEW.finished_at IS NOT NULL AND NEW.provider_reference_type='none' AND NEW.provider_message_id IS NULL AND EXISTS(SELECT 1 FROM app.send_approvals a WHERE a.id=OLD.approval_id AND a.state='consumed' AND a.expires_at<=now())) OR (OLD.state='dispatching' AND NEW.state IN ('reported','rejected','unknown')) OR (OLD.state IN ('reported','unknown') AND NEW.state IN ('reported','unknown','verified','rejected')) OR (OLD.state IN ('verified','rejected') AND NEW.state=OLD.state)) THEN RAISE EXCEPTION 'submission cannot be resent'; END IF;
 IF NOT (OLD.state='pending' AND NEW.state='dispatching') AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN RAISE EXCEPTION 'submission start immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER approved_send_submission_guard BEFORE INSERT OR UPDATE OR DELETE ON app.approved_send_submissions FOR EACH ROW EXECUTE FUNCTION app.guard_send_submission();
CREATE TABLE app.approved_send_manual_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),approval_id uuid NOT NULL,user_id uuid NOT NULL,account_id uuid NOT NULL,outcome text NOT NULL,note text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(approval_id,user_id,account_id) REFERENCES app.approved_send_submissions(approval_id,user_id,account_id),CHECK(outcome IN ('observed_sent','not_observed')),CHECK(length(note)<=2000)
);
CREATE TRIGGER approved_send_manual_reviews_append_only BEFORE UPDATE OR DELETE ON app.approved_send_manual_reviews FOR EACH ROW EXECUTE FUNCTION app.reject_canonical_history_mutation();
CREATE FUNCTION app.validate_approved_send_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d app.drafts%ROWTYPE;
BEGIN
 SELECT draft.* INTO d FROM app.send_approvals a JOIN app.drafts draft ON draft.id=a.draft_id WHERE a.id=NEW.approval_id;
 IF (NEW.payload->'recipients',NEW.payload->>'subject',NEW.payload->>'body',NEW.payload->>'bodyFormat') IS DISTINCT FROM (d.recipients,d.subject,d.body,d.body_format) THEN RAISE EXCEPTION 'submission content must equal approved draft revision'; END IF;
 IF NEW.payload ? 'sourceMessageId' AND NEW.payload->>'sourceMessageId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.messages WHERE id=(NEW.payload->>'sourceMessageId')::uuid AND account_id=NEW.account_id) THEN RAISE EXCEPTION 'reply context outside approved mailbox'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER approved_send_snapshot_scope BEFORE INSERT ON app.approved_send_submissions FOR EACH ROW EXECUTE FUNCTION app.validate_approved_send_snapshot();
