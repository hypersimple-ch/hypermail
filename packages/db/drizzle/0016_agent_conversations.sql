CREATE TABLE app.agent_conversations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES app.users(id),account_id uuid,scope text NOT NULL,context_message_id uuid,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,user_id),FOREIGN KEY(user_id,account_id) REFERENCES app.user_accounts(user_id,account_id),FOREIGN KEY(account_id,context_message_id) REFERENCES app.messages(account_id,id),
 CHECK((scope='mailbox' AND account_id IS NOT NULL) OR (scope='global' AND account_id IS NULL AND context_message_id IS NULL)),CHECK(version>0)
);
CREATE INDEX agent_conversations_owner_page ON app.agent_conversations(user_id,created_at,id);
CREATE TABLE app.agent_conversation_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid NOT NULL,user_id uuid NOT NULL,sequence integer NOT NULL,role text NOT NULL,content text NOT NULL,request_id uuid,request_digest text,reply_to uuid,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(conversation_id,sequence),UNIQUE(user_id,request_id),UNIQUE(reply_to),UNIQUE(id,conversation_id,user_id),UNIQUE(id,user_id),
 FOREIGN KEY(conversation_id,user_id) REFERENCES app.agent_conversations(id,user_id),FOREIGN KEY(reply_to,conversation_id,user_id) REFERENCES app.agent_conversation_messages(id,conversation_id,user_id),
 CHECK(sequence>0),CHECK(length(btrim(content))>0 AND length(content)<=16000),
 CHECK((role='user' AND request_id IS NOT NULL AND request_digest ~ '^[a-f0-9]{64}$' AND reply_to IS NULL) OR (role='assistant' AND request_id IS NULL AND request_digest IS NULL AND reply_to IS NOT NULL))
);
CREATE TRIGGER agent_conversation_messages_append_only BEFORE UPDATE OR DELETE ON app.agent_conversation_messages FOR EACH ROW EXECUTE FUNCTION app.reject_canonical_history_mutation();
CREATE TABLE app.agent_conversation_turns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_message_id uuid NOT NULL UNIQUE REFERENCES app.agent_conversation_messages(id),state text NOT NULL DEFAULT 'pending',attempt integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),claim_token uuid,claim_expires_at timestamptz,error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(state IN ('pending','running','completed','failed')),CHECK(attempt>=0),CHECK((state='running' AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL) OR (state<>'running' AND claim_expires_at IS NULL))
);
ALTER TABLE app.agent_conversation_turns ADD COLUMN model_failure_count integer NOT NULL DEFAULT 0 CHECK(model_failure_count BETWEEN 0 AND 3);
COMMENT ON COLUMN app.agent_conversation_turns.model_failure_count IS 'Generation failures in the current retry cycle; memory deferrals and expired claims do not consume model retries.';
CREATE INDEX conversation_turns_pending ON app.agent_conversation_turns(available_at,id) WHERE state='pending';
CREATE INDEX conversation_turns_expired ON app.agent_conversation_turns(claim_expires_at,id) WHERE state='running';
CREATE TABLE app.agent_global_memory_backfills (
 user_id uuid NOT NULL,account_id uuid NOT NULL,last_message_created_at timestamptz,last_message_id uuid,completed_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,account_id),FOREIGN KEY(user_id,account_id) REFERENCES app.user_accounts(user_id,account_id),FOREIGN KEY(last_message_id,user_id) REFERENCES app.agent_conversation_messages(id,user_id),CHECK((last_message_id IS NULL)=(last_message_created_at IS NULL))
);
CREATE FUNCTION app.guard_conversation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (NEW.id,NEW.user_id,NEW.account_id,NEW.scope,NEW.context_message_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.account_id,OLD.scope,OLD.context_message_id,OLD.created_at) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'conversation scope/version is immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER conversation_guard BEFORE UPDATE OR DELETE ON app.agent_conversations FOR EACH ROW EXECUTE FUNCTION app.guard_conversation();
CREATE FUNCTION app.guard_conversation_message_insert() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE parent_role text; next_sequence integer; BEGIN
 PERFORM 1 FROM app.agent_conversations WHERE id=NEW.conversation_id FOR UPDATE;
 SELECT coalesce(max(sequence),0)+1 INTO next_sequence FROM app.agent_conversation_messages WHERE conversation_id=NEW.conversation_id;
 IF NEW.sequence<>next_sequence THEN RAISE EXCEPTION 'conversation sequence must be contiguous'; END IF;
 IF NEW.role='assistant' THEN SELECT role INTO parent_role FROM app.agent_conversation_messages WHERE id=NEW.reply_to; IF parent_role IS DISTINCT FROM 'user' THEN RAISE EXCEPTION 'reply must target user message'; END IF; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER conversation_message_sequence BEFORE INSERT ON app.agent_conversation_messages FOR EACH ROW EXECUTE FUNCTION app.guard_conversation_message_insert();
CREATE FUNCTION app.guard_conversation_turn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN IF NOT EXISTS(SELECT 1 FROM app.agent_conversation_messages WHERE id=NEW.user_message_id AND role='user') THEN RAISE EXCEPTION 'turn requires user message'; END IF; RETURN NEW; END IF;
 IF TG_OP='DELETE' OR (NEW.id,NEW.user_message_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.user_message_id,OLD.created_at) THEN RAISE EXCEPTION 'turn identity immutable'; END IF;
 IF NEW.state='running' AND (OLD.state='pending' OR (OLD.state='running' AND OLD.claim_expires_at<=now())) THEN
  IF NEW.attempt<>OLD.attempt+1 OR NEW.claim_token IS NULL OR NEW.claim_token IS NOT DISTINCT FROM OLD.claim_token OR NEW.claim_expires_at>now()+interval '120 seconds' THEN RAISE EXCEPTION 'invalid turn claim'; END IF;
 ELSIF OLD.state='running' THEN
  IF NEW.attempt<>OLD.attempt OR NEW.claim_token IS DISTINCT FROM OLD.claim_token OR OLD.claim_expires_at<=now() THEN RAISE EXCEPTION 'stale turn claim'; END IF;
  IF NEW.state='running' AND (NEW.claim_expires_at<=OLD.claim_expires_at OR NEW.claim_expires_at>now()+interval '120 seconds') THEN RAISE EXCEPTION 'invalid turn renewal'; END IF;
  IF NEW.state NOT IN ('running','pending','completed','failed') THEN RAISE EXCEPTION 'invalid turn completion'; END IF;
 ELSIF OLD.state='failed' AND NEW.state='pending' AND NEW.attempt=OLD.attempt THEN NULL;
 ELSE RAISE EXCEPTION 'invalid turn transition'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER conversation_turn_guard BEFORE INSERT OR UPDATE OR DELETE ON app.agent_conversation_turns FOR EACH ROW EXECUTE FUNCTION app.guard_conversation_turn();
CREATE FUNCTION app.require_conversation_reply() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.state='completed') IS DISTINCT FROM EXISTS(SELECT 1 FROM app.agent_conversation_messages WHERE reply_to=NEW.user_message_id) THEN RAISE EXCEPTION 'completed turn requires unique reply'; END IF; RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER conversation_turn_reply AFTER INSERT OR UPDATE ON app.agent_conversation_turns DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.require_conversation_reply();
ALTER TABLE app.agent_conversation_messages ADD CONSTRAINT conversation_content_utf16 CHECK(app.utf16_length(content)<=16000);
ALTER TABLE app.agent_conversation_messages ADD CONSTRAINT conversation_request_digest_required CHECK(role<>'user' OR request_digest IS NOT NULL);
CREATE FUNCTION app.require_reply_completed_turn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.role='assistant' AND NOT EXISTS(SELECT 1 FROM app.agent_conversation_turns WHERE user_message_id=NEW.reply_to AND state='completed') THEN RAISE EXCEPTION 'assistant reply requires completed turn'; END IF; RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER conversation_reply_turn AFTER INSERT ON app.agent_conversation_messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.require_reply_completed_turn();
CREATE FUNCTION app.validate_global_backfill_watermark() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.last_message_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.agent_conversation_messages m JOIN app.agent_conversations c ON c.id=m.conversation_id WHERE m.id=NEW.last_message_id AND m.user_id=NEW.user_id AND m.role='user' AND c.scope='global' AND m.created_at=NEW.last_message_created_at) THEN RAISE EXCEPTION 'backfill watermark must identify explicit global owner message'; END IF; RETURN NEW; END $$;
CREATE TRIGGER global_memory_backfill_scope BEFORE INSERT OR UPDATE ON app.agent_global_memory_backfills FOR EACH ROW EXECUTE FUNCTION app.validate_global_backfill_watermark();
