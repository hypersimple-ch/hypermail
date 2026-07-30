import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('../drizzle/0000_solid_lady_deathstrike.sql', import.meta.url);
const lifecycleMigrationUrl = new URL('../drizzle/0001_lifecycle_retention.sql', import.meta.url);
const ownershipMigrationUrl = new URL('../drizzle/0002_user_account_ownership.sql', import.meta.url);
const sql = readFileSync(fileURLToPath(migrationUrl), 'utf8');
const lifecycleSql = readFileSync(fileURLToPath(lifecycleMigrationUrl), 'utf8');
const ownershipSql = readFileSync(fileURLToPath(ownershipMigrationUrl), 'utf8');

describe('initial domain migration', () => {
  it('isolates application, Mastra, and queue schemas', () => {
    expect(sql).toContain('CREATE SCHEMA "app"');
    expect(sql).toContain('CREATE SCHEMA "mastra"');
    expect(sql).toContain('CREATE SCHEMA "pgboss"');
  });

  it('enforces provider and visible-work idempotency', () => {
    expect(sql).toContain('"messages_provider_identity_unique"');
    expect(sql).toContain('"activities_message_unique"');
    expect(sql).toContain('"logical_notifications_activity_unique"');
    expect(sql).toContain('"agent_jobs_activity_unique"');
    expect(sql).toContain('"actions_idempotency_unique"');
    expect(sql).toContain('"send_approvals_idempotency_unique"');
  });

  it('contains only allowlisted autonomous action enum values', () => {
    const actionEnum = sql.match(/CREATE TYPE "app"\."action_kind" AS ENUM\(([^;]+)\)/)?.[1] ?? '';
    expect(actionEnum).toContain("'recoverable_trash'");
    expect(actionEnum).not.toMatch(/send|forward|permanent|remove_account|create_folder/i);
  });

  it('preserves history through restrictive activity and action references', () => {
    expect(sql).toContain('FOREIGN KEY ("message_id") REFERENCES "app"."messages"("id") ON DELETE restrict');
    expect(sql).toContain('FOREIGN KEY ("activity_id") REFERENCES "app"."activities"("id") ON DELETE restrict');
  });

  it('keeps send approvals tied to real application users and draft accounts', () => {
    expect(sql).toContain('FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE restrict');
    expect(sql).toContain('FOREIGN KEY ("draft_id") REFERENCES "app"."drafts"("id") ON DELETE restrict');
    expect(sql).toContain('FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE restrict');
  });

  it('makes user-account ownership explicit and unique', () => {
    expect(ownershipSql).toContain('CREATE TABLE "app"."user_accounts"');
    expect(ownershipSql).toContain('PRIMARY KEY("user_id","account_id")');
    expect(ownershipSql).toContain('REFERENCES "app"."users"("id") ON DELETE cascade');
    expect(ownershipSql).toContain('REFERENCES "app"."accounts"("id") ON DELETE cascade');
  });

  it('adds only lifecycle lookup indexes and preserves restrictive history foreign keys', () => {
    expect(lifecycleSql).toContain('"message_bodies_cached_at_idx"');
    expect(lifecycleSql).toContain('"push_subscriptions_expiry_cleanup_idx"');
    expect(lifecycleSql).not.toMatch(/delete\s+from/i);
    expect(sql).toContain('FOREIGN KEY ("subscription_id") REFERENCES "app"."push_subscriptions"("id") ON DELETE restrict');
  });
});
