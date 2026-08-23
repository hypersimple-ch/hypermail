import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe,expect,it } from 'vitest';
import { createPostgresClient } from '@hypermail/db';
import { PostgresAgentJobStore } from '../src/production.js';
import { withPostgresSchemas } from './postgres-test.js';
const url=process.env.DATABASE_URL;
describe('legacy Activity upgrade into durable task delivery',()=>{
 it.skipIf(!url)('backfills the canonical parent so a pre-upgrade job can claim an immutable Run',async()=>withPostgresSchemas(url??'',async sql=>{
  const user=randomUUID(),account=randomUUID(),assignment=randomUUID(),grant=randomUUID(),message=randomUUID(),activity=randomUUID(),job=randomUUID();
  await sql.begin(async tx=>{
   await tx`insert into app.users(id,email,password_hash) values(${user},${`${user}@t`},'h')`;
   await tx`insert into app.accounts(id,user_id,provider,provider_account_id,email,state,baseline_completed_at) values(${account},${user},'microsoft',${account},${`${account}@t`},'ready',now())`;
   await tx`insert into app.user_accounts(user_id,account_id) values(${user},${account})`;
   await tx`insert into app.mailbox_manager_assignments(id,user_id,account_id,manager_kind,automatic_processing_enabled) values(${assignment},${user},${account},'mastra',true)`;
   await tx`insert into app.agent_capability_grants(id,user_id,account_id,manager_kind,capabilities,invocation_modes,state,approved_at) values(${grant},${user},${account},'mastra',array['mail.read']::text[],array['automatic']::text[],'active',now())`;
   await tx`insert into app.messages(id,account_id,provider_message_id,sender,recipients,received_at) values(${message},${account},'legacy','{"address":"s@t"}','[]',now())`;
   await tx`insert into app.activities(id,account_id,message_id,state) values(${activity},${account},${message},'new')`;
   await tx`insert into app.agent_jobs(id,activity_id,idempotency_key,state) values(${job},${activity},${`agent:evaluate:${activity}`},'pending')`;
  });
  expect(await sql`select id from app.agent_activities where id=${activity}`).toEqual([]);
  const migration=await readFile(resolve(process.cwd(),'packages/db/drizzle/0011_durable_agent_tasks.sql'),'utf8');
  await sql.unsafe(migration.slice(0,migration.indexOf('-- Durable automatic-task delivery')));
  expect(await sql`select id from app.agent_activities where id=${activity}`).toEqual([{id:activity}]);
  const client=createPostgresClient(url??'');try{const claimed=await new PostgresAgentJobStore(client, 90, { retryBaseDelaySeconds: 5, retryMaximumDelaySeconds: 900, claimLeaseSeconds: 60, schedulerIntervalSeconds: 5 }).claim(job,user);expect(claimed?.activityId).toBe(activity);expect(await sql`select state from app.agent_runs where activity_id=${activity}`).toEqual([{state:'running'}]);}finally{await client.close();}
 }));
});
