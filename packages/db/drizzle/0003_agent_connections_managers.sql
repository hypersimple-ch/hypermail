CREATE TYPE "app"."agent_connection_state" AS ENUM('connected', 'paused', 'disconnected', 'security_revoked');
--> statement-breakpoint
CREATE TYPE "app"."mailbox_manager_kind" AS ENUM('mastra', 'agent_connection', 'none');
--> statement-breakpoint
CREATE TABLE "app"."agent_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "adapter" text NOT NULL,
  "external_profile_id" text NOT NULL,
  "display_name" text NOT NULL,
  "state" "app"."agent_connection_state" DEFAULT 'connected' NOT NULL,
  "lifecycle_revision" integer DEFAULT 1 NOT NULL,
  "verified_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_connections_adapter_valid" CHECK ("adapter" ~ '^[a-z][a-z0-9_-]*$'),
  CONSTRAINT "agent_connections_external_profile_nonempty" CHECK (length(btrim("external_profile_id")) > 0),
  CONSTRAINT "agent_connections_lifecycle_revision_positive" CHECK ("lifecycle_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "app"."agent_connections" ADD CONSTRAINT "agent_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_connections_external_profile_unique" ON "app"."agent_connections" USING btree ("user_id","adapter","external_profile_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_connections_user_id_unique" ON "app"."agent_connections" USING btree ("user_id","id");
--> statement-breakpoint
CREATE INDEX "agent_connections_user_state_idx" ON "app"."agent_connections" USING btree ("user_id","state");
--> statement-breakpoint
CREATE TABLE "app"."user_agent_preferences" (
  "user_id" uuid PRIMARY KEY NOT NULL,
  "default_manager_kind" "app"."mailbox_manager_kind" NOT NULL,
  "default_agent_connection_id" uuid,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_agent_preferences_manager_reference" CHECK ((
    ("default_manager_kind" = 'agent_connection' AND "default_agent_connection_id" IS NOT NULL)
    OR ("default_manager_kind" IN ('mastra', 'none') AND "default_agent_connection_id" IS NULL)
  )),
  CONSTRAINT "user_agent_preferences_revision_positive" CHECK ("revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "app"."user_agent_preferences" ADD CONSTRAINT "user_agent_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app"."user_agent_preferences" ADD CONSTRAINT "user_agent_preferences_owned_connection_fk" FOREIGN KEY ("user_id","default_agent_connection_id") REFERENCES "app"."agent_connections"("user_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "app"."mailbox_manager_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "manager_kind" "app"."mailbox_manager_kind" NOT NULL,
  "agent_connection_id" uuid,
  "automatic_processing_enabled" boolean DEFAULT false NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mailbox_manager_assignments_manager_reference" CHECK ((
    ("manager_kind" = 'agent_connection' AND "agent_connection_id" IS NOT NULL)
    OR ("manager_kind" IN ('mastra', 'none') AND "agent_connection_id" IS NULL)
  )),
  CONSTRAINT "mailbox_manager_assignments_revision_positive" CHECK ("revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_manager_assignments_user_account_unique" ON "app"."mailbox_manager_assignments" USING btree ("user_id","account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_manager_assignments_identity_unique" ON "app"."mailbox_manager_assignments" USING btree ("id","user_id","account_id");
--> statement-breakpoint
ALTER TABLE "app"."mailbox_manager_assignments" ADD CONSTRAINT "mailbox_manager_assignments_owned_mailbox_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "app"."user_accounts"("user_id","account_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app"."mailbox_manager_assignments" ADD CONSTRAINT "mailbox_manager_assignments_owned_connection_fk" FOREIGN KEY ("user_id","agent_connection_id") REFERENCES "app"."agent_connections"("user_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "app"."mailbox_manager_assignment_revisions" (
  "assignment_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "user_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "manager_kind" "app"."mailbox_manager_kind" NOT NULL,
  "agent_connection_id" uuid,
  "automatic_processing_enabled" boolean NOT NULL,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mailbox_manager_assignment_revisions_assignment_id_revision_pk" PRIMARY KEY("assignment_id","revision"),
  CONSTRAINT "mailbox_manager_assignment_revisions_manager_reference" CHECK ((
    ("manager_kind" = 'agent_connection' AND "agent_connection_id" IS NOT NULL)
    OR ("manager_kind" IN ('mastra', 'none') AND "agent_connection_id" IS NULL)
  )),
  CONSTRAINT "mailbox_manager_assignment_revisions_revision_positive" CHECK ("revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "app"."mailbox_manager_assignment_revisions" ADD CONSTRAINT "mailbox_manager_assignment_revisions_assignment_fk" FOREIGN KEY ("assignment_id","user_id","account_id") REFERENCES "app"."mailbox_manager_assignments"("id","user_id","account_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app"."mailbox_manager_assignment_revisions" ADD CONSTRAINT "mailbox_manager_assignment_revisions_owned_connection_fk" FOREIGN KEY ("user_id","agent_connection_id") REFERENCES "app"."agent_connections"("user_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION "app"."reject_mailbox_manager_assignment_revision_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'mailbox_manager_assignment_revisions is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "mailbox_manager_assignment_revisions_append_only"
BEFORE UPDATE OR DELETE ON "app"."mailbox_manager_assignment_revisions"
FOR EACH ROW EXECUTE FUNCTION "app"."reject_mailbox_manager_assignment_revision_mutation"();
--> statement-breakpoint
CREATE FUNCTION "app"."enforce_agent_connection_lifecycle_revision"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."state" IS DISTINCT FROM OLD."state" THEN
    NEW."updated_at" := GREATEST(clock_timestamp(), OLD."updated_at" + interval '1 microsecond');
    IF NEW."lifecycle_revision" <> OLD."lifecycle_revision" + 1 THEN
      RAISE EXCEPTION 'Agent Connection lifecycle change must increment revision exactly once';
    END IF;
  ELSIF NEW."lifecycle_revision" IS DISTINCT FROM OLD."lifecycle_revision" THEN
    RAISE EXCEPTION 'Agent Connection lifecycle revision requires a state change';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agent_connections_lifecycle_revision_fence"
BEFORE UPDATE ON "app"."agent_connections"
FOR EACH ROW EXECUTE FUNCTION "app"."enforce_agent_connection_lifecycle_revision"();
--> statement-breakpoint
CREATE FUNCTION "app"."enforce_user_agent_preference_revision"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."default_manager_kind", NEW."default_agent_connection_id")
       IS DISTINCT FROM (OLD."default_manager_kind", OLD."default_agent_connection_id") THEN
    NEW."updated_at" := GREATEST(clock_timestamp(), OLD."updated_at" + interval '1 microsecond');
    IF NEW."revision" <> OLD."revision" + 1 THEN
      RAISE EXCEPTION 'Default Mailbox Manager change must increment revision exactly once';
    END IF;
  ELSIF NEW."revision" IS DISTINCT FROM OLD."revision" THEN
    RAISE EXCEPTION 'Default Mailbox Manager revision requires a Manager change';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "user_agent_preferences_revision_fence"
BEFORE UPDATE ON "app"."user_agent_preferences"
FOR EACH ROW EXECUTE FUNCTION "app"."enforce_user_agent_preference_revision"();
--> statement-breakpoint
CREATE FUNCTION "app"."enforce_mailbox_manager_assignment_revision"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."manager_kind", NEW."agent_connection_id", NEW."automatic_processing_enabled")
       IS DISTINCT FROM
     (OLD."manager_kind", OLD."agent_connection_id", OLD."automatic_processing_enabled") THEN
    NEW."updated_at" := GREATEST(clock_timestamp(), OLD."updated_at" + interval '1 microsecond');
    IF NEW."revision" <> OLD."revision" + 1 THEN
      RAISE EXCEPTION 'Mailbox Manager assignment change must increment revision exactly once';
    END IF;
  ELSIF NEW."revision" IS DISTINCT FROM OLD."revision" THEN
    RAISE EXCEPTION 'Mailbox Manager assignment revision requires a configuration change';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "mailbox_manager_assignments_revision_fence"
BEFORE UPDATE ON "app"."mailbox_manager_assignments"
FOR EACH ROW EXECUTE FUNCTION "app"."enforce_mailbox_manager_assignment_revision"();
--> statement-breakpoint
CREATE FUNCTION "app"."record_mailbox_manager_assignment_revision"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "app"."mailbox_manager_assignment_revisions" (
    "assignment_id", "revision", "user_id", "account_id", "manager_kind",
    "agent_connection_id", "automatic_processing_enabled", "changed_at"
  ) VALUES (
    NEW."id", NEW."revision", NEW."user_id", NEW."account_id", NEW."manager_kind",
    NEW."agent_connection_id", NEW."automatic_processing_enabled", NEW."updated_at"
  );
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "mailbox_manager_assignments_initial_revision"
AFTER INSERT ON "app"."mailbox_manager_assignments"
FOR EACH ROW EXECUTE FUNCTION "app"."record_mailbox_manager_assignment_revision"();
--> statement-breakpoint
CREATE TRIGGER "mailbox_manager_assignments_changed_revision"
AFTER UPDATE OF "manager_kind", "agent_connection_id", "automatic_processing_enabled" ON "app"."mailbox_manager_assignments"
FOR EACH ROW WHEN (
  (NEW."manager_kind", NEW."agent_connection_id", NEW."automatic_processing_enabled")
    IS DISTINCT FROM
  (OLD."manager_kind", OLD."agent_connection_id", OLD."automatic_processing_enabled")
)
EXECUTE FUNCTION "app"."record_mailbox_manager_assignment_revision"();
--> statement-breakpoint
-- Migration 0002 introduced ownership edges without backfilling older installs.
-- Repair orphan legacy Mailboxes only when exactly one owner is provable; otherwise
-- stop the migration instead of guessing or silently leaving an unowned Mailbox.
DO $$
DECLARE
  orphan_count bigint;
  ambiguous_count bigint;
  user_count bigint;
  sole_user_id uuid;
BEGIN
  SELECT count(*) INTO ambiguous_count
  FROM (
    SELECT "account_id" FROM "app"."user_accounts"
    GROUP BY "account_id" HAVING count(*) > 1
  ) ambiguous;
  IF ambiguous_count > 0 THEN
    RAISE EXCEPTION 'cannot backfill mailbox managers: % mailbox(es) have multiple owners', ambiguous_count;
  END IF;

  SELECT count(*) INTO orphan_count
  FROM "app"."accounts" a
  WHERE NOT EXISTS (
    SELECT 1 FROM "app"."user_accounts" ua WHERE ua."account_id" = a."id"
  );

  IF orphan_count > 0 THEN
    SELECT count(*) INTO user_count FROM "app"."users";
    IF user_count <> 1 THEN
      RAISE EXCEPTION 'cannot backfill % unowned legacy mailbox(es): expected exactly one app.users owner, found %', orphan_count, user_count;
    END IF;
    SELECT "id" INTO sole_user_id FROM "app"."users" LIMIT 1;

    INSERT INTO "app"."user_accounts" ("user_id", "account_id")
    SELECT sole_user_id, a."id"
    FROM "app"."accounts" a
    WHERE NOT EXISTS (
      SELECT 1 FROM "app"."user_accounts" ua WHERE ua."account_id" = a."id"
    );
  END IF;
END $$;
--> statement-breakpoint
-- Preserve the current embedded-Mastra behavior for every existing User without
-- making it a default for Users created after this migration.
INSERT INTO "app"."user_agent_preferences" ("user_id", "default_manager_kind", "revision")
SELECT "id", 'mastra', 1 FROM "app"."users"
ON CONFLICT ("user_id") DO NOTHING;
--> statement-breakpoint
-- Backfill each unambiguous ownership edge; never infer an owner.
INSERT INTO "app"."mailbox_manager_assignments" ("user_id", "account_id", "manager_kind", "automatic_processing_enabled", "revision")
SELECT "user_id", "account_id", 'mastra', true, 1 FROM "app"."user_accounts"
ON CONFLICT ("user_id", "account_id") DO NOTHING;
--> statement-breakpoint
