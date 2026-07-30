CREATE SCHEMA "app";
--> statement-breakpoint
CREATE SCHEMA "mastra";
--> statement-breakpoint
CREATE SCHEMA "pgboss";
--> statement-breakpoint
CREATE TYPE "app"."account_state" AS ENUM('pending', 'ready', 'degraded', 'disabled');--> statement-breakpoint
CREATE TYPE "app"."action_kind" AS ENUM('archive', 'recoverable_trash', 'move', 'mark_read', 'mark_unread', 'draft_create', 'draft_edit');--> statement-breakpoint
CREATE TYPE "app"."action_state" AS ENUM('planned', 'executing', 'succeeded', 'failed', 'unverifiable', 'incorrect');--> statement-breakpoint
CREATE TYPE "app"."activity_state" AS ENUM('new', 'waiting_question', 'failed', 'handled', 'acknowledged');--> statement-breakpoint
CREATE TYPE "app"."decision_state" AS ENUM('pending', 'question', 'actionable', 'no_action', 'failed');--> statement-breakpoint
CREATE TYPE "app"."delivery_state" AS ENUM('pending', 'succeeded', 'retryable', 'permanent_failure');--> statement-breakpoint
CREATE TYPE "app"."draft_state" AS ENUM('editing', 'ready', 'sending', 'sent', 'failed', 'discarded');--> statement-breakpoint
CREATE TYPE "app"."health_state" AS ENUM('healthy', 'degraded', 'failed', 'paused');--> statement-breakpoint
CREATE TYPE "app"."job_state" AS ENUM('pending', 'running', 'suspended', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "app"."notification_state" AS ENUM('pending', 'delivering', 'delivered', 'failed', 'suppressed');--> statement-breakpoint
CREATE TYPE "app"."provider" AS ENUM('microsoft', 'gmail', 'imap');--> statement-breakpoint
CREATE TYPE "app"."question_state" AS ENUM('open', 'answered', 'cancelled');--> statement-breakpoint
CREATE TYPE "app"."send_approval_state" AS ENUM('pending', 'consumed', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "app"."verification_state" AS ENUM('pending', 'verified', 'failed', 'unverifiable');--> statement-breakpoint
CREATE TABLE "app"."account_health" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"state" "app"."health_state" DEFAULT 'healthy' NOT NULL,
	"reason_code" text,
	"detail" text,
	"first_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "app"."provider" NOT NULL,
	"provider_account_id" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"state" "app"."account_state" DEFAULT 'pending' NOT NULL,
	"baseline_completed_at" timestamp with time zone,
	"autonomy_paused_at" timestamp with time zone,
	"autonomy_pause_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."action_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"state" "app"."verification_state" NOT NULL,
	"observed" jsonb NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_verifications_attempt_positive" CHECK ("app"."action_verifications"."attempt" > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"kind" "app"."action_kind" NOT NULL,
	"state" "app"."action_state" DEFAULT 'planned' NOT NULL,
	"idempotency_key" text NOT NULL,
	"target" jsonb NOT NULL,
	"precondition" jsonb NOT NULL,
	"provider_receipt" jsonb,
	"error_code" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"state" "app"."activity_state" DEFAULT 'new' NOT NULL,
	"last_error_code" text,
	"handled_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activities_version_positive" CHECK ("app"."activities"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."agent_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" "app"."job_state" DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" text,
	"queue_job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_jobs_attempt_nonnegative" CHECK ("app"."agent_jobs"."attempt" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"provider_attachment_id" text NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"inline" boolean DEFAULT false NOT NULL,
	"content_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_size_nonnegative" CHECK ("app"."attachments"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"account_id" uuid,
	"activity_id" uuid,
	"event" text NOT NULL,
	"correlation_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."auth_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"password" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."auth_rate_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"lastRequest" bigint NOT NULL,
	CONSTRAINT "auth_rate_limits_count_nonnegative" CHECK ("app"."auth_rate_limits"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."auth_users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."auth_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"state" "app"."decision_state" NOT NULL,
	"rationale" text NOT NULL,
	"model_provider" text NOT NULL,
	"model_name" text NOT NULL,
	"input_digest" text NOT NULL,
	"output" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decisions_attempt_positive" CHECK ("app"."decisions"."attempt" > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."draft_revisions" (
	"draft_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"editor" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_revisions_draft_id_version_pk" PRIMARY KEY("draft_id","version"),
	CONSTRAINT "draft_revisions_version_positive" CHECK ("app"."draft_revisions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"source_message_id" uuid,
	"provider_draft_id" text,
	"created_by" text NOT NULL,
	"state" "app"."draft_state" DEFAULT 'editing' NOT NULL,
	"recipients" jsonb NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drafts_version_positive" CHECK ("app"."drafts"."version" > 0),
	CONSTRAINT "drafts_creator_allowed" CHECK ("app"."drafts"."created_by" in ('user', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "app"."folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"provider_folder_id" text NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"parent_provider_folder_id" text,
	"selectable" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."logical_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" uuid NOT NULL,
	"state" "app"."notification_state" DEFAULT 'pending' NOT NULL,
	"sender_label" text NOT NULL,
	"subject" text NOT NULL,
	"status_label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."message_bodies" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"text_body" text,
	"sanitized_html_body" text,
	"cached_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purge_after" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"provider_message_id" text NOT NULL,
	"provider_thread_id" text,
	"folder_id" uuid,
	"internet_message_id" text,
	"sender" jsonb NOT NULL,
	"recipients" jsonb NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"preview" text DEFAULT '' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"is_baseline" boolean DEFAULT false NOT NULL,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"provider_version" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"state" "app"."delivery_state" DEFAULT 'pending' NOT NULL,
	"response_code" integer,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "notification_deliveries_attempt_positive" CHECK ("app"."notification_deliveries"."attempt" > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."poll_states" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"checkpoint_observed_at" timestamp with time zone,
	"last_poll_started_at" timestamp with time zone,
	"last_poll_succeeded_at" timestamp with time zone,
	"last_reconciled_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poll_states_failures_nonnegative" CHECK ("app"."poll_states"."consecutive_failures" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint_hash" text NOT NULL,
	"endpoint_ciphertext" text NOT NULL,
	"p256dh_ciphertext" text NOT NULL,
	"auth_ciphertext" text NOT NULL,
	"expires_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"state" "app"."question_state" DEFAULT 'open' NOT NULL,
	"answer" text,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."rate_limits" (
	"bucket" text NOT NULL,
	"subject_hash" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"blocked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limits_bucket_subject_hash_pk" PRIMARY KEY("bucket","subject_hash"),
	CONSTRAINT "rate_limits_count_nonnegative" CHECK ("app"."rate_limits"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."recovery_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."safety_windows" (
	"account_id" uuid NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"verified_mutations" integer DEFAULT 0 NOT NULL,
	"incorrect_mutations" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "safety_windows_account_id_window_started_at_pk" PRIMARY KEY("account_id","window_started_at"),
	CONSTRAINT "safety_windows_verified_nonnegative" CHECK ("app"."safety_windows"."verified_mutations" >= 0),
	CONSTRAINT "safety_windows_incorrect_nonnegative" CHECK ("app"."safety_windows"."incorrect_mutations" >= 0),
	CONSTRAINT "safety_windows_incorrect_bounded" CHECK ("app"."safety_windows"."incorrect_mutations" <= "app"."safety_windows"."verified_mutations")
);
--> statement-breakpoint
CREATE TABLE "app"."scheduler_leases" (
	"name" text PRIMARY KEY NOT NULL,
	"holder_id" text NOT NULL,
	"fencing_token" integer NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scheduler_leases_fencing_positive" CHECK ("app"."scheduler_leases"."fencing_token" > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."send_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"draft_version" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"state" "app"."send_approval_state" DEFAULT 'pending' NOT NULL,
	"confirmation_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."account_health" ADD CONSTRAINT "account_health_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."action_verifications" ADD CONSTRAINT "action_verifications_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "app"."actions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."actions" ADD CONSTRAINT "actions_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "app"."activities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."actions" ADD CONSTRAINT "actions_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "app"."decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activities" ADD CONSTRAINT "activities_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "app"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activities" ADD CONSTRAINT "activities_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_jobs" ADD CONSTRAINT "agent_jobs_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "app"."activities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "app"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."audits" ADD CONSTRAINT "audits_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."audits" ADD CONSTRAINT "audits_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "app"."activities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_accounts" ADD CONSTRAINT "auth_accounts_userId_auth_users_id_fk" FOREIGN KEY ("userId") REFERENCES "app"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_sessions" ADD CONSTRAINT "auth_sessions_userId_auth_users_id_fk" FOREIGN KEY ("userId") REFERENCES "app"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."decisions" ADD CONSTRAINT "decisions_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "app"."activities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."draft_revisions" ADD CONSTRAINT "draft_revisions_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "app"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."drafts" ADD CONSTRAINT "drafts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."drafts" ADD CONSTRAINT "drafts_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "app"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."folders" ADD CONSTRAINT "folders_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."logical_notifications" ADD CONSTRAINT "logical_notifications_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "app"."activities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."message_bodies" ADD CONSTRAINT "message_bodies_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "app"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."messages" ADD CONSTRAINT "messages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."messages" ADD CONSTRAINT "messages_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "app"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_logical_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "app"."logical_notifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_subscription_id_push_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "app"."push_subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."poll_states" ADD CONSTRAINT "poll_states_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."questions" ADD CONSTRAINT "questions_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "app"."activities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."questions" ADD CONSTRAINT "questions_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "app"."decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."recovery_tokens" ADD CONSTRAINT "recovery_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."safety_windows" ADD CONSTRAINT "safety_windows_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."send_approvals" ADD CONSTRAINT "send_approvals_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "app"."drafts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."send_approvals" ADD CONSTRAINT "send_approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_identity_unique" ON "app"."accounts" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_email_unique" ON "app"."accounts" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "action_verifications_attempt_unique" ON "app"."action_verifications" USING btree ("action_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "actions_idempotency_unique" ON "app"."actions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "actions_activity_idx" ON "app"."actions" USING btree ("activity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "activities_message_unique" ON "app"."activities" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "activities_state_created_idx" ON "app"."activities" USING btree ("state","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_jobs_activity_unique" ON "app"."agent_jobs" USING btree ("activity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_jobs_idempotency_unique" ON "app"."agent_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_provider_identity_unique" ON "app"."attachments" USING btree ("message_id","provider_attachment_id");--> statement-breakpoint
CREATE INDEX "audits_occurred_idx" ON "app"."audits" USING btree ("occurred_at","id");--> statement-breakpoint
CREATE INDEX "audits_activity_idx" ON "app"."audits" USING btree ("activity_id","occurred_at");--> statement-breakpoint
CREATE INDEX "auth_accounts_user_id_idx" ON "app"."auth_accounts" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_accounts_provider_account_unique" ON "app"."auth_accounts" USING btree ("providerId","accountId");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_rate_limits_key_unique" ON "app"."auth_rate_limits" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_unique" ON "app"."auth_sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_id_idx" ON "app"."auth_sessions" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_users_email_unique" ON "app"."auth_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "auth_verifications_identifier_idx" ON "app"."auth_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_activity_attempt_unique" ON "app"."decisions" USING btree ("activity_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_provider_identity_unique" ON "app"."drafts" USING btree ("account_id","provider_draft_id") WHERE "app"."drafts"."provider_draft_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "folders_provider_identity_unique" ON "app"."folders" USING btree ("account_id","provider_folder_id");--> statement-breakpoint
CREATE INDEX "folders_account_role_idx" ON "app"."folders" USING btree ("account_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "logical_notifications_activity_unique" ON "app"."logical_notifications" USING btree ("activity_id");--> statement-breakpoint
CREATE INDEX "message_bodies_purge_idx" ON "app"."message_bodies" USING btree ("purge_after");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_identity_unique" ON "app"."messages" USING btree ("account_id","provider_message_id");--> statement-breakpoint
CREATE INDEX "messages_inbox_page_idx" ON "app"."messages" USING btree ("account_id","received_at","id");--> statement-breakpoint
CREATE INDEX "messages_internet_message_idx" ON "app"."messages" USING btree ("account_id","internet_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_attempt_unique" ON "app"."notification_deliveries" USING btree ("notification_id","subscription_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_unique" ON "app"."push_subscriptions" USING btree ("endpoint_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "questions_one_open_per_activity" ON "app"."questions" USING btree ("activity_id") WHERE "app"."questions"."state" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_tokens_hash_unique" ON "app"."recovery_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "send_approvals_confirmation_unique" ON "app"."send_approvals" USING btree ("confirmation_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "send_approvals_idempotency_unique" ON "app"."send_approvals" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_unique" ON "app"."sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_expiry_idx" ON "app"."sessions" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "app"."users" USING btree ("email");