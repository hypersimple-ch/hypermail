import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres, { type Sql } from 'postgres';

const migrations = ['0000_solid_lady_deathstrike.sql', '0001_lifecycle_retention.sql', '0002_user_account_ownership.sql', '0003_agent_connections_managers.sql', '0004_tenant_mailbox_identity.sql', '0005_agent_capability_grants.sql', '0006_agent_oauth.sql', '0007_agent_work_history.sql', '0008_agent_work_integration.sql', '0009_public_mcp_execution.sql', '0010_owner_send_approval.sql', '0011_durable_agent_tasks.sql'];

/**
 * Runs against a deliberately reset local database. The session advisory lock makes
 * independently discovered worker integration files serialize rather than racing
 * over the shared app/mastra/pgboss schemas.
 */
export async function withPostgresSchemas<T>(databaseUrl: string, work: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql.unsafe('SELECT pg_advisory_lock(825649471)');
    await sql.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await sql.unsafe('DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA IF EXISTS mastra CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE');
    for (const file of migrations) {
      const migration = await readFile(resolve(process.cwd(), 'packages/db/drizzle', file), 'utf8');
      for (const statement of migration.split('--> statement-breakpoint')) if (statement.trim()) await sql.unsafe(statement);
    }
    return await work(sql);
  } finally {
    try {
      await sql.unsafe('DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA IF EXISTS mastra CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE');
      await sql.unsafe('SELECT pg_advisory_unlock(825649471)');
    } finally {
      await sql.end();
    }
  }
}
