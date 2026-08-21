ALTER TABLE "app"."accounts" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
-- Every mailbox must have exactly one compatibility ownership edge after 0003.
DO $$
BEGIN
  IF EXISTS (SELECT account_id FROM "app"."user_accounts" GROUP BY account_id HAVING count(*) <> 1) THEN
    RAISE EXCEPTION 'cannot tenant-qualify mailbox with ambiguous ownership';
  END IF;
END $$;
--> statement-breakpoint
-- Copy that owner onto the mailbox before making the authoritative tenant key mandatory.
UPDATE "app"."accounts" a
SET "user_id" = ua."user_id"
FROM "app"."user_accounts" ua
WHERE ua."account_id" = a."id";
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "app"."accounts" WHERE "user_id" IS NULL) THEN
    RAISE EXCEPTION 'cannot tenant-qualify mailbox without exactly one owner';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "app"."accounts" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "app"."accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_user_provider_identity_unique" ON "app"."accounts" USING btree ("user_id","provider","provider_account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_user_email_unique" ON "app"."accounts" USING btree ("user_id",lower("email"));
--> statement-breakpoint
DROP INDEX "app"."accounts_provider_identity_unique";
--> statement-breakpoint
DROP INDEX "app"."accounts_email_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_user_id_id_unique" ON "app"."accounts" USING btree ("user_id","id");
--> statement-breakpoint
-- Keep user_accounts as the single-owner compatibility edge while accounts.user_id
-- becomes the authoritative tenant identity used by runtime queries.
CREATE UNIQUE INDEX "user_accounts_account_unique" ON "app"."user_accounts" USING btree ("account_id");
--> statement-breakpoint
ALTER TABLE "app"."user_accounts" ADD CONSTRAINT "user_accounts_owned_account_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "app"."accounts"("user_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Deferred consistency lets account projection create the authoritative row and its
-- compatibility edge in either order inside one transaction, but never commit an orphan.
CREATE FUNCTION "app"."enforce_account_ownership_edge"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  candidate_account_id uuid;
  candidate_account_ids uuid[];
  expected_user_id uuid;
  matching_edges bigint;
BEGIN
  IF TG_TABLE_NAME = 'accounts' THEN
    candidate_account_ids := ARRAY[NEW."id"];
  ELSIF TG_OP = 'INSERT' THEN
    candidate_account_ids := ARRAY[NEW."account_id"];
  ELSIF TG_OP = 'DELETE' THEN
    candidate_account_ids := ARRAY[OLD."account_id"];
  ELSIF OLD."account_id" = NEW."account_id" THEN
    candidate_account_ids := ARRAY[NEW."account_id"];
  ELSE
    candidate_account_ids := ARRAY[OLD."account_id", NEW."account_id"];
  END IF;

  FOREACH candidate_account_id IN ARRAY candidate_account_ids LOOP
    SELECT "user_id" INTO expected_user_id
    FROM "app"."accounts" WHERE "id" = candidate_account_id;
    IF FOUND THEN
      SELECT count(*) INTO matching_edges
      FROM "app"."user_accounts"
      WHERE "account_id" = candidate_account_id AND "user_id" = expected_user_id;
      IF matching_edges <> 1 THEN
        RAISE EXCEPTION 'account % must retain exactly one matching ownership edge', candidate_account_id;
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "accounts_require_ownership_edge"
AFTER INSERT OR UPDATE ON "app"."accounts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "app"."enforce_account_ownership_edge"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "user_accounts_preserve_account_owner"
AFTER INSERT OR UPDATE OR DELETE ON "app"."user_accounts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "app"."enforce_account_ownership_edge"();
