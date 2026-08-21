CREATE TABLE "app"."oauth_public_clients" (
  "client_id" text PRIMARY KEY NOT NULL,
  "display_name" text NOT NULL,
  "user_id" uuid NOT NULL,
  "agent_connection_id" uuid NOT NULL,
  "allowed_scope" text DEFAULT 'agent:mailbox' NOT NULL CHECK ("allowed_scope" = 'agent:mailbox'),
  "revoked_at" timestamptz,
  "redirect_uris" text[] NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "oauth_public_clients_owned_connection" FOREIGN KEY ("user_id", "agent_connection_id") REFERENCES "app"."agent_connections"("user_id", "id") ON DELETE CASCADE,
  CONSTRAINT "oauth_public_clients_id_nonempty" CHECK (length(btrim("client_id")) > 0),
  CONSTRAINT "oauth_public_clients_redirects_nonempty" CHECK (cardinality("redirect_uris") > 0 AND "app"."text_array_is_unique"("redirect_uris"))
);
CREATE TABLE "app"."agent_safety_ceiling" (
  "singleton" boolean PRIMARY KEY DEFAULT true NOT NULL CHECK ("singleton"),
  "revision" integer DEFAULT 1 NOT NULL CHECK ("revision" > 0),
  "capabilities" text[] NOT NULL,
  "invocation_modes" text[] NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "agent_safety_ceiling_values" CHECK (cardinality("capabilities") > 0 AND "app"."text_array_is_unique"("capabilities") AND "capabilities" <@ ARRAY['mail.list','mail.search','mail.read','attachment.read','folder.list','mail.archive','mail.trash_recoverable','mail.move','mail.mark_read','mail.mark_unread','draft.create','draft.edit','send.request']::text[] AND cardinality("invocation_modes") > 0 AND "app"."text_array_is_unique"("invocation_modes") AND "invocation_modes" <@ ARRAY['interactive','automatic']::text[])
);
INSERT INTO "app"."agent_safety_ceiling" ("capabilities", "invocation_modes") VALUES (ARRAY['mail.list','mail.search','mail.read','attachment.read','folder.list','mail.archive','mail.trash_recoverable','mail.move','mail.mark_read','mail.mark_unread','draft.create','draft.edit','send.request'], ARRAY['interactive','automatic']);
CREATE TABLE "app"."oauth_consent_requests" (
 "request_digest" text PRIMARY KEY NOT NULL, "client_id" text NOT NULL REFERENCES "app"."oauth_public_clients"("client_id"),
 "redirect_uri" text NOT NULL, "user_id" uuid NOT NULL, "connection_id" uuid NOT NULL, "account_id" uuid,
 "scope" text NOT NULL CHECK ("scope"='agent:mailbox'), "code_challenge" text NOT NULL, "state" text,
 "expires_at" timestamptz NOT NULL, "consumed_at" timestamptz, "created_at" timestamptz DEFAULT now() NOT NULL,
 CONSTRAINT "oauth_consent_owned_connection" FOREIGN KEY ("user_id","connection_id") REFERENCES "app"."agent_connections"("user_id","id") ON DELETE CASCADE,
 CONSTRAINT "oauth_consent_owned_mailbox" FOREIGN KEY ("user_id","account_id") REFERENCES "app"."user_accounts"("user_id","account_id") ON DELETE CASCADE
);
CREATE TABLE "app"."oauth_authorization_codes" (
 "code_digest" text PRIMARY KEY NOT NULL, "client_id" text NOT NULL REFERENCES "app"."oauth_public_clients"("client_id") ON DELETE RESTRICT,
 "redirect_uri" text NOT NULL, "user_id" uuid NOT NULL REFERENCES "app"."users"("id") ON DELETE CASCADE,
 "connection_id" uuid NOT NULL REFERENCES "app"."agent_connections"("id") ON DELETE CASCADE,
 "account_id" uuid NOT NULL REFERENCES "app"."accounts"("id") ON DELETE CASCADE,
 "code_challenge" text NOT NULL CHECK ("code_challenge" ~ '^[A-Za-z0-9_-]{43}$'), "scope" text NOT NULL CHECK ("scope" = 'agent:mailbox'),
 "lifecycle_revision" integer NOT NULL CHECK ("lifecycle_revision" > 0), "assignment_revision" integer NOT NULL CHECK ("assignment_revision" > 0), "grant_revision" integer NOT NULL CHECK ("grant_revision" > 0), "safety_revision" integer NOT NULL CHECK ("safety_revision" > 0),
 "expires_at" timestamptz NOT NULL, "consumed_at" timestamptz, "created_at" timestamptz DEFAULT now() NOT NULL,
 CONSTRAINT "oauth_codes_owned_connection" FOREIGN KEY ("user_id", "connection_id") REFERENCES "app"."agent_connections"("user_id", "id") ON DELETE CASCADE,
 CONSTRAINT "oauth_codes_owned_mailbox" FOREIGN KEY ("user_id", "account_id") REFERENCES "app"."user_accounts"("user_id", "account_id") ON DELETE CASCADE
);
CREATE TABLE "app"."oauth_token_families" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "client_id" text NOT NULL REFERENCES "app"."oauth_public_clients"("client_id"),
 "user_id" uuid NOT NULL, "connection_id" uuid NOT NULL, "account_id" uuid NOT NULL, "current_generation" integer DEFAULT 0 NOT NULL CHECK ("current_generation" >= 0), "expires_at" timestamptz DEFAULT (now()+interval '30 days') NOT NULL, "revocation_reason" text, "revoked_at" timestamptz, "created_at" timestamptz DEFAULT now() NOT NULL,
 CONSTRAINT "oauth_families_owned_connection" FOREIGN KEY ("user_id", "connection_id") REFERENCES "app"."agent_connections"("user_id", "id"),
 CONSTRAINT "oauth_families_owned_mailbox" FOREIGN KEY ("user_id", "account_id") REFERENCES "app"."user_accounts"("user_id", "account_id")
);
CREATE TABLE "app"."oauth_tokens" (
 "token_digest" text PRIMARY KEY NOT NULL, "family_id" uuid NOT NULL REFERENCES "app"."oauth_token_families"("id") ON DELETE CASCADE,
 "kind" text NOT NULL CHECK ("kind" IN ('access','refresh')), "generation" integer NOT NULL CHECK ("generation" >= 0), "audience" text NOT NULL, "scope" text NOT NULL CHECK ("scope" = 'agent:mailbox'),
 "lifecycle_revision" integer NOT NULL CHECK ("lifecycle_revision" > 0), "assignment_revision" integer NOT NULL CHECK ("assignment_revision" > 0),
 "grant_revision" integer NOT NULL CHECK ("grant_revision" > 0), "safety_revision" integer NOT NULL CHECK ("safety_revision" > 0),
 "expires_at" timestamptz NOT NULL, "consumed_at" timestamptz, "revoked_at" timestamptz, "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "oauth_tokens_family_idx" ON "app"."oauth_tokens" ("family_id");
