CREATE TYPE "app"."capability_grant_state" AS ENUM('active', 'revoked', 'reapproval_required');

CREATE FUNCTION "app"."text_array_is_unique"(value text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT cardinality(value) = count(DISTINCT item) FROM unnest(value) AS item;
$$;

CREATE TABLE "app"."agent_connection_reconnect_proofs" (
  "event_id" text PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "verified_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "lifecycle_revision" integer
);
ALTER TABLE "app"."agent_connection_reconnect_proofs" ADD CONSTRAINT "agent_connection_reconnect_proofs_user_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE RESTRICT;
ALTER TABLE "app"."agent_connection_reconnect_proofs" ADD CONSTRAINT "agent_connection_reconnect_proofs_connection_fk" FOREIGN KEY ("connection_id") REFERENCES "app"."agent_connections"("id") ON DELETE RESTRICT;

CREATE TABLE "app"."agent_connection_reconnect_events" (
  "event_id" text PRIMARY KEY NOT NULL,
  "connection_id" uuid NOT NULL,
  "lifecycle_revision" integer NOT NULL,
  "verified_at" timestamp with time zone NOT NULL
);
CREATE UNIQUE INDEX "agent_connection_reconnect_events_revision_unique" ON "app"."agent_connection_reconnect_events" ("connection_id", "lifecycle_revision");
ALTER TABLE "app"."agent_connection_reconnect_events" ADD CONSTRAINT "agent_connection_reconnect_events_connection_fk"
  FOREIGN KEY ("connection_id") REFERENCES "app"."agent_connections"("id") ON DELETE RESTRICT;

CREATE TABLE "app"."agent_capability_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "manager_kind" "app"."mailbox_manager_kind" NOT NULL,
  "agent_connection_id" uuid,
  "capabilities" text[] NOT NULL,
  "invocation_modes" text[] NOT NULL,
  "state" "app"."capability_grant_state" DEFAULT 'active' NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "approved_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_capability_grants_manager_reference" CHECK (
    ("manager_kind" = 'agent_connection' AND "agent_connection_id" IS NOT NULL)
    OR ("manager_kind" = 'mastra' AND "agent_connection_id" IS NULL)
  ),
  CONSTRAINT "agent_capability_grants_revision_positive" CHECK ("revision" > 0),
  CONSTRAINT "agent_capability_grants_capabilities_closed" CHECK (
    cardinality("capabilities") > 0
    AND "capabilities" <@ ARRAY['mail.list','mail.search','mail.read','attachment.read','folder.list','mail.archive','mail.trash_recoverable','mail.move','mail.mark_read','mail.mark_unread','draft.create','draft.edit','send.request']::text[]
    AND "app"."text_array_is_unique"("capabilities")
  ),
  CONSTRAINT "agent_capability_grants_invocation_modes_closed" CHECK (
    cardinality("invocation_modes") > 0
    AND "invocation_modes" <@ ARRAY['interactive','automatic']::text[]
    AND "app"."text_array_is_unique"("invocation_modes")
  )
);

CREATE UNIQUE INDEX "agent_capability_grants_user_account_unique" ON "app"."agent_capability_grants" ("user_id", "account_id");
CREATE UNIQUE INDEX "agent_capability_grants_identity_unique" ON "app"."agent_capability_grants" ("id", "user_id", "account_id");
ALTER TABLE "app"."agent_capability_grants" ADD CONSTRAINT "agent_capability_grants_assignment_fk"
  FOREIGN KEY ("user_id", "account_id") REFERENCES "app"."mailbox_manager_assignments"("user_id", "account_id") ON DELETE CASCADE;
ALTER TABLE "app"."agent_capability_grants" ADD CONSTRAINT "agent_capability_grants_owned_connection_fk"
  FOREIGN KEY ("user_id", "agent_connection_id") REFERENCES "app"."agent_connections"("user_id", "id") ON DELETE RESTRICT;

CREATE TABLE "app"."agent_capability_grant_revisions" (
  "grant_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "user_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "manager_kind" "app"."mailbox_manager_kind" NOT NULL,
  "agent_connection_id" uuid,
  "capabilities" text[] NOT NULL,
  "invocation_modes" text[] NOT NULL,
  "state" "app"."capability_grant_state" NOT NULL,
  "approved_at" timestamp with time zone NOT NULL,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "agent_capability_grant_revisions_grant_id_revision_pk" PRIMARY KEY("grant_id", "revision"),
  CONSTRAINT "agent_capability_grant_revisions_manager_reference" CHECK (
    ("manager_kind" = 'agent_connection' AND "agent_connection_id" IS NOT NULL)
    OR ("manager_kind" = 'mastra' AND "agent_connection_id" IS NULL)
  ),
  CONSTRAINT "agent_capability_grant_revisions_revision_positive" CHECK ("revision" > 0),
  CONSTRAINT "agent_capability_grant_revisions_capabilities_closed" CHECK (
    cardinality("capabilities") > 0
    AND "capabilities" <@ ARRAY['mail.list','mail.search','mail.read','attachment.read','folder.list','mail.archive','mail.trash_recoverable','mail.move','mail.mark_read','mail.mark_unread','draft.create','draft.edit','send.request']::text[]
    AND "app"."text_array_is_unique"("capabilities")
  ),
  CONSTRAINT "agent_capability_grant_revisions_invocation_modes_closed" CHECK (
    cardinality("invocation_modes") > 0
    AND "invocation_modes" <@ ARRAY['interactive','automatic']::text[]
    AND "app"."text_array_is_unique"("invocation_modes")
  )
);
ALTER TABLE "app"."agent_capability_grant_revisions" ADD CONSTRAINT "agent_capability_grant_revisions_grant_fk"
  FOREIGN KEY ("grant_id", "user_id", "account_id") REFERENCES "app"."agent_capability_grants"("id", "user_id", "account_id") ON DELETE RESTRICT;
ALTER TABLE "app"."agent_capability_grant_revisions" ADD CONSTRAINT "agent_capability_grant_revisions_owned_connection_fk"
  FOREIGN KEY ("user_id", "agent_connection_id") REFERENCES "app"."agent_connections"("user_id", "id") ON DELETE RESTRICT;

CREATE TABLE "app"."capability_grant_reapproval_events" (
  "event_id" text PRIMARY KEY NOT NULL,
  "grant_id" uuid NOT NULL,
  "grant_revision" integer NOT NULL,
  "approver_user_id" uuid NOT NULL,
  "approved_at" timestamp with time zone NOT NULL
);
ALTER TABLE "app"."capability_grant_reapproval_events" ADD CONSTRAINT "capability_grant_reapproval_events_revision_fk"
  FOREIGN KEY ("grant_id", "grant_revision") REFERENCES "app"."agent_capability_grant_revisions"("grant_id", "revision") ON DELETE RESTRICT;
ALTER TABLE "app"."capability_grant_reapproval_events" ADD CONSTRAINT "capability_grant_reapproval_events_approver_fk"
  FOREIGN KEY ("approver_user_id") REFERENCES "app"."users"("id") ON DELETE RESTRICT;

CREATE FUNCTION "app"."enforce_agent_capability_grant_revision"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."user_id", NEW."account_id") IS DISTINCT FROM (OLD."user_id", OLD."account_id") THEN
    RAISE EXCEPTION 'capability grant mailbox identity is immutable';
  END IF;
  IF (NEW."manager_kind", NEW."agent_connection_id", NEW."capabilities", NEW."invocation_modes", NEW."state", NEW."approved_at")
       IS DISTINCT FROM (OLD."manager_kind", OLD."agent_connection_id", OLD."capabilities", OLD."invocation_modes", OLD."state", OLD."approved_at") THEN
    NEW."updated_at" := GREATEST(clock_timestamp(), OLD."updated_at" + interval '1 microsecond');
    IF NEW."revision" <> OLD."revision" + 1 THEN
      RAISE EXCEPTION 'capability grant revision must advance exactly once';
    END IF;
  ELSIF NEW."revision" <> OLD."revision" THEN
    RAISE EXCEPTION 'capability grant revision cannot change without authority change';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "agent_capability_grants_revision_fence"
BEFORE UPDATE ON "app"."agent_capability_grants"
FOR EACH ROW EXECUTE FUNCTION "app"."enforce_agent_capability_grant_revision"();

CREATE FUNCTION "app"."record_agent_capability_grant_revision"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "app"."agent_capability_grant_revisions" (
    "grant_id", "revision", "user_id", "account_id", "manager_kind", "agent_connection_id",
    "capabilities", "invocation_modes", "state", "approved_at", "changed_at", "created_at"
  ) VALUES (
    NEW."id", NEW."revision", NEW."user_id", NEW."account_id", NEW."manager_kind", NEW."agent_connection_id",
    NEW."capabilities", NEW."invocation_modes", NEW."state", NEW."approved_at", NEW."updated_at", NEW."created_at"
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER "agent_capability_grants_record_insert"
AFTER INSERT ON "app"."agent_capability_grants"
FOR EACH ROW EXECUTE FUNCTION "app"."record_agent_capability_grant_revision"();
CREATE TRIGGER "agent_capability_grants_record_update"
AFTER UPDATE OF "manager_kind", "agent_connection_id", "capabilities", "invocation_modes", "state", "approved_at" ON "app"."agent_capability_grants"
FOR EACH ROW WHEN (
  (NEW."manager_kind", NEW."agent_connection_id", NEW."capabilities", NEW."invocation_modes", NEW."state", NEW."approved_at")
  IS DISTINCT FROM (OLD."manager_kind", OLD."agent_connection_id", OLD."capabilities", OLD."invocation_modes", OLD."state", OLD."approved_at")
)
EXECUTE FUNCTION "app"."record_agent_capability_grant_revision"();

CREATE FUNCTION "app"."reject_agent_capability_grant_revision_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'agent_capability_grant_revisions is append-only';
END;
$$;
CREATE TRIGGER "agent_capability_grant_revisions_append_only"
BEFORE UPDATE OR DELETE ON "app"."agent_capability_grant_revisions"
FOR EACH ROW EXECUTE FUNCTION "app"."reject_agent_capability_grant_revision_mutation"();


CREATE FUNCTION "app"."enforce_capability_grant_matches_assignment"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_user uuid := COALESCE(NEW."user_id", OLD."user_id");
  v_account uuid := COALESCE(NEW."account_id", OLD."account_id");
BEGIN
  IF EXISTS (
    SELECT 1 FROM "app"."agent_capability_grants" g
    JOIN "app"."mailbox_manager_assignments" a ON a."user_id" = g."user_id" AND a."account_id" = g."account_id"
    WHERE g."user_id" = v_user AND g."account_id" = v_account
      AND g."state" <> 'revoked'
      AND (g."manager_kind", g."agent_connection_id") IS DISTINCT FROM (a."manager_kind", a."agent_connection_id")
  ) THEN
    RAISE EXCEPTION 'capability grant manager must match current mailbox assignment';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "agent_capability_grants_assignment_match"
AFTER INSERT OR UPDATE ON "app"."agent_capability_grants"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "app"."enforce_capability_grant_matches_assignment"();
CREATE CONSTRAINT TRIGGER "mailbox_manager_assignments_grant_match"
AFTER UPDATE OF "manager_kind", "agent_connection_id" ON "app"."mailbox_manager_assignments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "app"."enforce_capability_grant_matches_assignment"();


CREATE FUNCTION "app"."require_grant_reapproval_after_security_revocation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "app"."agent_capability_grants"
  SET "state" = 'reapproval_required', "revision" = "revision" + 1, "updated_at" = now()
  WHERE "user_id" = NEW."user_id" AND "agent_connection_id" = NEW."id" AND "state" = 'active';
  RETURN NEW;
END;
$$;
CREATE TRIGGER "agent_connections_security_revocation_reapproval"
AFTER UPDATE OF "state" ON "app"."agent_connections"
FOR EACH ROW WHEN (NEW."state" = 'security_revoked' AND OLD."state" IS DISTINCT FROM NEW."state")
EXECUTE FUNCTION "app"."require_grant_reapproval_after_security_revocation"();


CREATE FUNCTION "app"."enforce_verified_security_reconnect"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."state" = 'security_revoked' AND NEW."state" = 'connected' AND NOT EXISTS (
    SELECT 1 FROM "app"."agent_connection_reconnect_events" e
    WHERE e."connection_id" = NEW."id" AND e."lifecycle_revision" = NEW."lifecycle_revision"
  ) THEN
    RAISE EXCEPTION 'security-revoked connection requires a persisted verified reconnect event';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "agent_connections_verified_security_reconnect"
AFTER UPDATE OF "state" ON "app"."agent_connections"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "app"."enforce_verified_security_reconnect"();
