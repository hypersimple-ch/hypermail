import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL('../drizzle/0000_solid_lady_deathstrike.sql', import.meta.url);
const lifecycleMigrationUrl = new URL('../drizzle/0001_lifecycle_retention.sql', import.meta.url);
const ownershipMigrationUrl = new URL('../drizzle/0002_user_account_ownership.sql', import.meta.url);
const tenantMigrationUrl = new URL('../drizzle/0004_tenant_mailbox_identity.sql', import.meta.url);
const managerMigrationUrl = new URL('../drizzle/0003_agent_connections_managers.sql', import.meta.url);
const grantMigrationUrl = new URL('../drizzle/0005_agent_capability_grants.sql', import.meta.url);
const workIntegrationMigrationUrl = new URL('../drizzle/0008_agent_work_integration.sql', import.meta.url);
const ownerSendMigrationUrl = new URL('../drizzle/0010_owner_send_approval.sql', import.meta.url);
const journalUrl = new URL('../drizzle/meta/_journal.json', import.meta.url);
const workerMigrationRunnerUrl = new URL('../../../apps/worker/test/postgres-test.ts', import.meta.url);
const sql = readFileSync(fileURLToPath(migrationUrl), 'utf8');
const lifecycleSql = readFileSync(fileURLToPath(lifecycleMigrationUrl), 'utf8');
const ownershipSql = readFileSync(fileURLToPath(ownershipMigrationUrl), 'utf8');
const tenantSql = readFileSync(fileURLToPath(tenantMigrationUrl), 'utf8');
const managerSql = readFileSync(fileURLToPath(managerMigrationUrl), 'utf8');
const grantSql = readFileSync(fileURLToPath(grantMigrationUrl), 'utf8');
const workIntegrationSql = readFileSync(fileURLToPath(workIntegrationMigrationUrl), 'utf8');
const ownerSendSql = readFileSync(fileURLToPath(ownerSendMigrationUrl), 'utf8');
const journal = readFileSync(fileURLToPath(journalUrl), 'utf8');
const workerMigrationRunner = readFileSync(fileURLToPath(workerMigrationRunnerUrl), 'utf8');

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


describe('Agent Connection and Mailbox Manager migration', () => {
  it('enforces stable external profile identity per User and adapter', () => {
    expect(managerSql).toContain('CREATE TABLE "app"."agent_connections"');
    expect(managerSql).toContain('"agent_connections_external_profile_unique"');
    expect(managerSql).toContain('("user_id","adapter","external_profile_id")');
    expect(managerSql).toContain('"lifecycle_revision" integer DEFAULT 1 NOT NULL');
  });

  it('database-constrains Manager discriminants and owned connection references', () => {
    expect(managerSql).toContain(`CREATE TYPE "app"."mailbox_manager_kind" AS ENUM('mastra', 'agent_connection', 'none')`);
    expect(managerSql).toContain('"mailbox_manager_assignments_manager_reference"');
    expect(managerSql).toContain('"user_agent_preferences_manager_reference"');
    expect(managerSql).toContain('FOREIGN KEY ("user_id","agent_connection_id") REFERENCES "app"."agent_connections"("user_id","id")');
    expect(managerSql).toContain('FOREIGN KEY ("user_id","account_id") REFERENCES "app"."user_accounts"("user_id","account_id")');
  });

  it('stores an immutable assignment snapshot for every current revision', () => {
    expect(managerSql).toContain('CREATE TABLE "app"."mailbox_manager_assignment_revisions"');
    expect(managerSql).toContain('PRIMARY KEY("assignment_id","revision")');
    expect(managerSql).toContain('ON DELETE restrict');
    expect(managerSql).toContain('mailbox_manager_assignment_revisions_append_only');
    expect(managerSql).toContain('BEFORE UPDATE OR DELETE');
    expect(managerSql).toContain('agent_connections_lifecycle_revision_fence');
    expect(managerSql).toContain('user_agent_preferences_revision_fence');
    expect(managerSql).toContain('mailbox_manager_assignments_revision_fence');
    expect(managerSql).toContain('mailbox_manager_assignments_initial_revision');
    expect(managerSql).toContain('mailbox_manager_assignments_changed_revision');
    expect(managerSql).not.toMatch(/UPDATE\s+"app"\."mailbox_manager_assignment_revisions"\s+SET/i);
  });

  it('repairs only provable legacy ownership and backfills every ownership edge to Mastra', () => {
    expect(managerSql).toContain('IF ambiguous_count > 0 THEN');
    expect(managerSql).toContain('IF user_count <> 1 THEN');
    expect(managerSql).toContain("RAISE EXCEPTION 'cannot backfill % unowned legacy mailbox(es)");
    expect(managerSql).toContain('INSERT INTO "app"."user_accounts"');
    expect(managerSql).toContain(`SELECT "user_id", "account_id", 'mastra', true, 1 FROM "app"."user_accounts"`);
    expect(managerSql).toContain('INSERT INTO "app"."mailbox_manager_assignment_revisions"');
  });

  it('is registered in both the Drizzle journal and worker test migration runner', () => {
    expect(journal).toContain('"tag": "0003_agent_connections_managers"');
    expect(workerMigrationRunner).toContain("'0003_agent_connections_managers.sql'");
  });

  it('keeps migration history additive', () => {
    expect(managerSql).not.toMatch(/DROP\s+(TABLE|COLUMN|TYPE)|DELETE\s+FROM|TRUNCATE/i);
  });
});


describe('tenant mailbox identity expansion migration', () => {
  it('makes accounts owner-authoritative and constrains the compatibility edge to that owner', () => {
    expect(tenantSql).toContain('ADD COLUMN "user_id" uuid');
    expect(tenantSql).toContain('GROUP BY account_id HAVING count(*) <> 1');
    expect(tenantSql).toContain('ALTER COLUMN "user_id" SET NOT NULL');
    expect(tenantSql).toContain('"user_accounts_account_unique"');
    expect(tenantSql).toContain('FOREIGN KEY ("user_id","account_id") REFERENCES "app"."accounts"("user_id","id")');
    expect(tenantSql).toContain('CREATE CONSTRAINT TRIGGER "accounts_require_ownership_edge"');
    expect(tenantSql).toContain('CREATE CONSTRAINT TRIGGER "user_accounts_preserve_account_owner"');
    expect(tenantSql).toContain('DEFERRABLE INITIALLY DEFERRED');
  });

  it('replaces global account identities after tenant-routed provider composition', () => {
    expect(tenantSql).toContain('"accounts_user_provider_identity_unique"');
    expect(tenantSql).toContain('"accounts_user_email_unique"');
    expect(tenantSql).toMatch(/DROP INDEX "app"\."accounts_provider_identity_unique"/);
    expect(tenantSql).toMatch(/DROP INDEX "app"\."accounts_email_unique"/);
    expect(sql).toContain('"accounts_provider_identity_unique"');
    expect(sql).toContain('"accounts_email_unique"');
  });

  it('is registered in migration runners', () => {
    expect(journal).toContain('"tag": "0004_tenant_mailbox_identity"');
    expect(workerMigrationRunner).toContain("'0004_tenant_mailbox_identity.sql'");
  });
});


describe('Agent capability grant migration', () => {
  it('creates closed current and append-only revisioned grants after 0004', () => {
    expect(grantSql).toContain('CREATE TABLE "app"."agent_capability_grants"');
    expect(grantSql).toContain('CREATE TABLE "app"."agent_capability_grant_revisions"');
    expect(grantSql).toContain('agent_capability_grant_revisions_append_only');
    expect(grantSql).toContain('text_array_is_unique');
    expect(grantSql).toContain("'send.request'");
    expect(grantSql).not.toContain("'send_email'");
  });
  it('binds grant Manager to assignment and security revocation to reapproval', () => {
    expect(grantSql).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(grantSql).toContain('capability grant manager must match current mailbox assignment');
    expect(grantSql).toContain(`AND g."state" <> 'revoked'`);
    expect(grantSql).toContain('agent_connections_security_revocation_reapproval');
    expect(grantSql).toContain('capability_grant_reapproval_events');
  });
  it('is registered after 0004 in both migration runners', () => {
    expect(journal).toContain('"tag": "0005_agent_capability_grants"');
    expect(workerMigrationRunner).toContain("'0005_agent_capability_grants.sql'");
  });

  it('backfills only reviewed legacy automatic Mastra authority and links jobs to Runs', () => {
    expect(workIntegrationSql).toContain("a.manager_kind='mastra'");
    expect(workIntegrationSql).toContain('a.automatic_processing_enabled');
    expect(workIntegrationSql).toContain('a.revision=1');
    expect(workIntegrationSql).toContain("ARRAY['automatic']");
    expect(workIntegrationSql).toContain('agent_run_id');
    expect(workIntegrationSql).not.toContain("manager_kind='agent_connection'");
    expect(journal).toContain('0008_agent_work_integration');
  });

});


describe('owner send approval migration',()=>{
  it('registers the additive owner bridge and commits enum additions separately',()=>{expect(journal).toContain('0010_owner_send_approval');expect(ownerSendSql.match(/statement-breakpoint/g)).toHaveLength(4);expect(ownerSendSql).toContain("pending_owner_approval' AND NEW.state IN ('expired','cancelled','rejected','sending')");expect(ownerSendSql).toContain("OLD.state='unverifiable' AND NEW.state IN ('approved','failed')");});
  it('tenant-binds canonical execution and requires readback evidence',()=>{expect(ownerSendSql).toContain('FOREIGN KEY(run_id,user_id,account_id)');expect(ownerSendSql).toContain('FOREIGN KEY(action_id,user_id,account_id)');expect(ownerSendSql).toContain("v.verifier='hypermail_provider_readback'");expect(ownerSendSql).toContain('provider identity is immutable');expect(ownerSendSql).toContain("r.outcome='action_requests_emitted' AND r.error_code IS NULL");expect(ownerSendSql).toContain("a.error_code=NEW.reason_code");expect(ownerSendSql).toContain("r.outcome='failed' AND r.error_code=NEW.reason_code");expect(ownerSendSql).toContain('public_send_request_id uuid UNIQUE');});
});


describe('durable automatic Task migration',()=>{
 const taskSql=readFileSync(fileURLToPath(new URL('../drizzle/0011_durable_agent_tasks.sql',import.meta.url)),'utf8');
 it('backfills pre-dual-write Activities before adding Task foreign keys',()=>{expect(taskSql.indexOf('INSERT INTO app.agent_activities')).toBeGreaterThanOrEqual(0);expect(taskSql.indexOf('INSERT INTO app.agent_activities')).toBeLessThan(taskSql.indexOf('CREATE TABLE "app"."agent_tasks"'));expect(taskSql).toContain("ON CONFLICT(id) DO NOTHING");});
 it('persists fenced leases, immutable Attempts/reports/receipts, outbox, and mutation journals',()=>{for(const name of ['agent_tasks','agent_task_delivery_attempts','agent_task_reports','agent_task_receipts','agent_task_outbox','agent_mutation_idempotency'])expect(taskSql).toContain(`"app"."${name}"`);expect(taskSql).toContain('agent_task_attempts_append_only');expect(taskSql).toContain('agent_tasks_lease_shape');expect(taskSql).toContain('agent_task_outbox_pending_idx');});
 it('registers the upgrade in every migration runner',()=>{expect(journal).toContain('0011_durable_agent_tasks');expect(workerMigrationRunner).toContain('0011_durable_agent_tasks.sql');});
});
