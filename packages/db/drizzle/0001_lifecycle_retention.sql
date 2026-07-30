CREATE INDEX "message_bodies_cached_at_idx" ON "app"."message_bodies" USING btree ("cached_at");
--> statement-breakpoint
CREATE INDEX "push_subscriptions_expiry_cleanup_idx" ON "app"."push_subscriptions" USING btree ("expires_at") WHERE "disabled_at" IS NULL AND "expires_at" IS NOT NULL;
