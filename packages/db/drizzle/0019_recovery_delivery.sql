CREATE TABLE app.recovery_mail_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id uuid NOT NULL REFERENCES app.users(id),recovery_id uuid NOT NULL UNIQUE,recipient text NOT NULL,encrypted_payload text,nonce text,
 state text NOT NULL DEFAULT 'pending',attempt integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),claim_token uuid,claim_expires_at timestamptz,provider_message_id text NOT NULL UNIQUE,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(recovery_id,owner_id) REFERENCES app.recovery_tokens(id,user_id),CHECK(state IN ('pending','processing','delivered','failed')),CHECK(attempt BETWEEN 0 AND 3),CHECK((encrypted_payload IS NULL)=(nonce IS NULL)),
 CHECK((state='processing' AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL) OR (state<>'processing' AND claim_expires_at IS NULL)),CHECK(state<>'delivered' OR encrypted_payload IS NULL)
);
CREATE INDEX recovery_mail_deliveries_pending ON app.recovery_mail_deliveries(next_attempt_at,id) WHERE state='pending';
CREATE INDEX recovery_mail_deliveries_expired_claim ON app.recovery_mail_deliveries(claim_expires_at,id) WHERE state='processing';
-- Identification hashes survive ciphertext minimization and token expiry; no raw URL/token.
CREATE TABLE app.recovery_mail_identifiers (
 recovery_id uuid PRIMARY KEY REFERENCES app.recovery_tokens(id),owner_id uuid NOT NULL,token_hash text NOT NULL UNIQUE,provider_message_id text NOT NULL UNIQUE,canonical_origin text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(recovery_id,owner_id) REFERENCES app.recovery_tokens(id,user_id),CHECK(length(token_hash)>0)
);
CREATE TRIGGER recovery_mail_identifiers_append_only BEFORE UPDATE OR DELETE ON app.recovery_mail_identifiers FOR EACH ROW EXECUTE FUNCTION app.reject_canonical_history_mutation();
CREATE FUNCTION app.guard_recovery_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM app.users u JOIN app.recovery_tokens t ON t.user_id=u.id WHERE u.id=NEW.owner_id AND t.id=NEW.recovery_id AND u.email=NEW.recipient AND t.expires_at=NEW.expires_at) OR NEW.state<>'pending' OR NEW.attempt<>0 OR NEW.encrypted_payload IS NULL THEN RAISE EXCEPTION 'recovery delivery must match owner token'; END IF; RETURN NEW; END IF;
 IF TG_OP='DELETE' OR (NEW.id,NEW.owner_id,NEW.recovery_id,NEW.recipient,NEW.provider_message_id,NEW.expires_at,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.recovery_id,OLD.recipient,OLD.provider_message_id,OLD.expires_at,OLD.created_at) THEN RAISE EXCEPTION 'recovery delivery identity immutable'; END IF;
 IF (NEW.encrypted_payload,NEW.nonce) IS DISTINCT FROM (OLD.encrypted_payload,OLD.nonce) AND NOT (NEW.encrypted_payload IS NULL AND NEW.nonce IS NULL AND (NEW.state IN ('delivered','failed') OR NEW.expires_at<=now())) THEN RAISE EXCEPTION 'recovery ciphertext immutable'; END IF;
 IF OLD.state IN ('pending','processing','failed') AND NEW.state='failed' AND NEW.expires_at<=now() AND NEW.attempt=OLD.attempt THEN NULL;
 ELSIF NEW.state='processing' AND (OLD.state='pending' OR (OLD.state='processing' AND OLD.claim_expires_at<=now())) THEN
  IF NEW.attempt<>OLD.attempt+1 OR NEW.claim_token IS NULL OR NEW.claim_token IS NOT DISTINCT FROM OLD.claim_token OR NEW.expires_at<=now() OR NEW.claim_expires_at>now()+interval '120 seconds' THEN RAISE EXCEPTION 'invalid recovery claim'; END IF;
 ELSIF OLD.state='processing' AND OLD.claim_expires_at<=now() AND OLD.attempt=3 AND NEW.state='failed' AND NEW.attempt=OLD.attempt AND NEW.encrypted_payload IS NULL AND NEW.claim_token IS NOT DISTINCT FROM OLD.claim_token THEN NULL;
 ELSIF OLD.state='processing' AND NEW.state IN ('pending','delivered','failed') THEN
  IF NEW.attempt<>OLD.attempt OR NEW.claim_token IS DISTINCT FROM OLD.claim_token OR OLD.claim_expires_at<=now() THEN RAISE EXCEPTION 'stale recovery completion'; END IF;
 ELSE RAISE EXCEPTION 'invalid recovery delivery transition'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER recovery_mail_delivery_guard BEFORE INSERT OR UPDATE OR DELETE ON app.recovery_mail_deliveries FOR EACH ROW EXECUTE FUNCTION app.guard_recovery_delivery();
