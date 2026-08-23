-- Durable, tenant-owned Mailbox-memory projection outbox (Issue #31).
CREATE TYPE "app"."mailbox_memory_event_state" AS ENUM('pending','processing','completed','cancelled');
--> statement-breakpoint
CREATE TABLE "app"."mailbox_memory_events" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "source_type" text NOT NULL,
  "source_id" uuid NOT NULL,
  "source_version" integer DEFAULT 1 NOT NULL,
  "kind" text NOT NULL,
  "content_digest" text NOT NULL,
  "content_payload" jsonb,
  "state" "app"."mailbox_memory_event_state" DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "claim_generation" integer DEFAULT 0 NOT NULL,
  "claim_token" uuid,
  "claim_worker" text,
  "claimed_at" timestamptz,
  "claim_expires_at" timestamptz,
  "available_at" timestamptz NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "completed_at" timestamptz,
  "cancelled_at" timestamptz,
  "result_metadata" jsonb,
  "last_error_code" text,
  "last_error_metadata" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "mailbox_memory_events_source_unique" UNIQUE("user_id","account_id","source_type","source_id","source_version","kind"),
  CONSTRAINT "mailbox_memory_events_owned_mailbox_fk" FOREIGN KEY("user_id","account_id") REFERENCES "app"."user_accounts"("user_id","account_id") ON DELETE restrict,
  CONSTRAINT "mailbox_memory_events_source_type_valid" CHECK(source_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT "mailbox_memory_events_kind_valid" CHECK(kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT "mailbox_memory_events_digest_valid" CHECK(content_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "mailbox_memory_events_counts_valid" CHECK(source_version>0 AND attempt_count>=0 AND claim_generation=attempt_count),
  CONSTRAINT "mailbox_memory_events_payload_valid" CHECK(content_payload IS NULL OR jsonb_typeof(content_payload)='object'),
  CONSTRAINT "mailbox_memory_events_metadata_valid" CHECK(
    (result_metadata IS NULL OR (jsonb_typeof(result_metadata)='object' AND octet_length(result_metadata::text)<=8192))
    AND (last_error_metadata IS NULL OR (jsonb_typeof(last_error_metadata)='object' AND octet_length(last_error_metadata::text)<=8192))
    AND (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$')
  ),
  CONSTRAINT "mailbox_memory_events_state_shape" CHECK(
    (state='pending' AND claim_worker IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL AND completed_at IS NULL AND cancelled_at IS NULL)
    OR (state='processing' AND claim_token IS NOT NULL AND claim_worker IS NOT NULL AND claimed_at IS NOT NULL AND claim_expires_at IS NOT NULL AND completed_at IS NULL AND cancelled_at IS NULL)
    OR (state='completed' AND claim_token IS NOT NULL AND claim_worker IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL AND completed_at IS NOT NULL AND cancelled_at IS NULL AND content_payload IS NULL)
    OR (state='cancelled' AND claim_worker IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL AND completed_at IS NULL AND cancelled_at IS NOT NULL AND content_payload IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX "mailbox_memory_events_claim_idx" ON "app"."mailbox_memory_events"("available_at","occurred_at","id") WHERE state='pending';
--> statement-breakpoint
CREATE INDEX "mailbox_memory_events_expired_claim_idx" ON "app"."mailbox_memory_events"("claim_expires_at","id") WHERE state='processing';
--> statement-breakpoint
CREATE FUNCTION app.guard_mailbox_memory_event_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'mailbox memory events are append-only';
  END IF;
  IF ROW(NEW.id,NEW.user_id,NEW.account_id,NEW.source_type,NEW.source_id,NEW.source_version,NEW.kind,
         NEW.content_digest,NEW.occurred_at,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.user_id,OLD.account_id,OLD.source_type,OLD.source_id,OLD.source_version,OLD.kind,
         OLD.content_digest,OLD.occurred_at,OLD.created_at) THEN
    RAISE EXCEPTION 'mailbox memory event identity is immutable';
  END IF;

  IF NEW.content_payload IS DISTINCT FROM OLD.content_payload
     AND NOT (OLD.content_payload IS NOT NULL AND NEW.content_payload IS NULL AND NEW.state IN ('completed','cancelled')) THEN
    RAISE EXCEPTION 'mailbox memory event content is immutable except for terminal minimization';
  END IF;

  IF OLD.state='pending' AND NEW.state='cancelled' THEN
    IF NEW.attempt_count<>OLD.attempt_count OR NEW.claim_generation<>OLD.claim_generation OR NEW.claim_token IS DISTINCT FROM OLD.claim_token THEN
      RAISE EXCEPTION 'invalid mailbox memory event cancellation fence';
    END IF;
  ELSIF OLD.state='pending' AND NEW.state='processing' THEN
    IF NEW.attempt_count<>OLD.attempt_count+1 OR NEW.claim_generation<>OLD.claim_generation+1
       OR NEW.claim_token IS NULL OR NEW.claim_token IS NOT DISTINCT FROM OLD.claim_token THEN
      RAISE EXCEPTION 'invalid mailbox memory event claim fence';
    END IF;
  ELSIF OLD.state='processing' AND NEW.state='processing' THEN
    IF NEW.attempt_count<>OLD.attempt_count OR NEW.claim_generation<>OLD.claim_generation
       OR NEW.claim_token IS DISTINCT FROM OLD.claim_token OR NEW.claim_expires_at<=OLD.claim_expires_at THEN
      RAISE EXCEPTION 'invalid mailbox memory event lease renewal';
    END IF;
  ELSIF OLD.state='processing' AND NEW.state IN ('pending','completed','cancelled') THEN
    IF NEW.attempt_count<>OLD.attempt_count OR NEW.claim_generation<>OLD.claim_generation
       OR NEW.claim_token IS DISTINCT FROM OLD.claim_token THEN
      RAISE EXCEPTION 'invalid mailbox memory event terminal fence';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid mailbox memory event state transition';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER mailbox_memory_events_append_only BEFORE UPDATE OR DELETE ON app.mailbox_memory_events
FOR EACH ROW EXECUTE FUNCTION app.guard_mailbox_memory_event_history();
