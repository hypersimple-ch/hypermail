import { randomUUID } from 'node:crypto';
import { describe,expect,it } from 'vitest';
import { createPostgresClient } from '@hypermail/db';
import { PostgresAgentConnectionsRepository } from '../../src/agent-connections/postgres-repository.js';
import { PostgresAgentRepository } from '../../src/agent/postgres-repository.js';
import { withPostgresSchemas } from '../../../worker/test/postgres-test.js';
const url=process.env.DATABASE_URL;
describe('owner assistant activation PostgreSQL',()=>{
 it.skipIf(!url)('atomically installs minimal authority once under concurrent revision confirmation',async()=>{
  await withPostgresSchemas(url??'',async sql=>{
   const user=randomUUID(),account=randomUUID();
   await sql`insert into app.users(id,email,password_hash) values(${user},${`${user}@example.test`},'hash')`;
   await sql.begin(async tx=>{
    await tx`insert into app.accounts(id,user_id,provider,provider_account_id,email,state) values(${account},${user},'microsoft',${account},'mailbox@example.test','ready')`;
    await tx`insert into app.user_accounts(user_id,account_id) values(${user},${account})`;
   });
   await sql`insert into app.mailbox_manager_assignments(user_id,account_id,manager_kind) values(${user},${account},'none')`;
   const client=createPostgresClient(url??'');try{
    const repository=new PostgresAgentConnectionsRepository(client);
    const results=await Promise.allSettled([repository.activateAssistant(user,account,1,null),repository.activateAssistant(user,account,1,null)]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    const settings=await repository.read(user);const mailbox=settings.mailboxes[0];
    expect(mailbox?.assignment).toMatchObject({manager:{kind:'mastra'},automaticProcessingEnabled:true,revision:2});
    expect(mailbox?.grant).toMatchObject({state:'active',revision:1});
    expect(mailbox?.grant?.capabilities).toEqual(['mail.list','mail.search','mail.read','attachment.read','folder.list','mail.archive','mail.move','mail.trash_recoverable','draft.create','draft.edit']);
    expect(await sql`select count(*)::integer count from app.agent_capability_grant_revisions where account_id=${account}`).toEqual([{count:1}]);
    expect(await sql`select count(*)::integer count from app.capability_grant_reapproval_events where approver_user_id=${user}`).toEqual([{count:1}]);
    expect(await sql`select count(*)::integer count from app.audits where account_id=${account} and event='agent.assistant_activated'`).toEqual([{count:1}]);
    const agent=new PostgresAgentRepository(client),scope={subjectId:user,accountIds:[account]};
    const before=await agent.dashboard(scope);
    expect(await agent.setAutonomy(scope,{kind:'global'},'paused',before.autonomy.global.version)).toEqual({kind:'updated',state:'paused'});
    const future=randomUUID();
    await sql.begin(async tx=>{
     await tx`insert into app.accounts(id,user_id,provider,provider_account_id,email,state) values(${future},${user},'microsoft',${future},'future@example.test','ready')`;
     await tx`insert into app.user_accounts(user_id,account_id) values(${user},${future})`;
    });
    expect((await agent.dashboard({subjectId:user,accountIds:[account,future]})).autonomy.global.state).toBe('paused');
    expect(await sql`select autonomy_paused_at is null as locally_running from app.accounts where id=${future}`).toEqual([{locally_running:true}]);
   }finally{await client.close();}
  });
 },30_000);
});
