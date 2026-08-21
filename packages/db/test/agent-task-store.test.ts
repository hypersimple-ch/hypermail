/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */
import { randomUUID } from 'node:crypto';
import { describe,expect,it } from 'vitest';
import { withPostgresSchemas } from '../../../apps/worker/test/postgres-test.js';
import { AgentTaskStore,type SqlClient } from '../src/index.js';

class ClockSql implements SqlClient {
  readonly calls:Array<{statement:string;values?:readonly unknown[]}>=[];
  constructor(readonly databaseTime:Date){}
  query<Row extends Record<string,unknown>>(statement:string,values?:readonly unknown[]):Promise<{rows:Row[]}>{
    this.calls.push({statement,values});
    if(statement.includes('clock_timestamp()')) return Promise.resolve({rows:[{database_time:this.databaseTime}] as Row[]});
    if(statement.includes("from app.agent_tasks t where t.state='pending'")) return Promise.resolve({rows:[]});
    throw new Error(`unexpected query: ${statement}`);
  }
  transaction<T>(operation:(sql:SqlClient)=>Promise<T>):Promise<T>{return operation(this);}
}

describe('AgentTaskStore database clock',()=>{
  it('uses transaction database time for claim eligibility',async()=>{
    const dbTime=new Date('2026-01-01T00:00:00.000Z');const sql=new ClockSql(dbTime);const store=new AgentTaskStore(sql);
    await expect(store.claim({kind:'mastra'},'worker')).resolves.toBeNull();
    const claim=sql.calls.find(call=>call.statement.includes("from app.agent_tasks t where t.state='pending'"));
    expect(claim?.values?.[2]).toBe(dbTime.toISOString());
  });

  it('binds concurrency admission to the same transaction before persisting a lease',async()=>{
    const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,now=new Date('2026-01-01T00:00:00.000Z');
    const row={id:id(1),activity_id:id(2),user_id:id(3),account_id:id(4),manager_kind:'mastra',manager_connection_id:null,manager_lifecycle_revision:null,assignment_id:id(5),assignment_revision:1,grant_id:id(6),grant_revision:1,safety_revision:1,state:'pending',pending_reason:'initial',version:1,attempt_count:0,max_attempts:5,lease_generation:0,lease_token_digest:null,lease_claimed_by:null,lease_claimed_at:null,lease_heartbeat_at:null,lease_expires_at:null,current_run_id:null,result:null,last_error_code:null,available_at:now,deadline_at:new Date('2026-01-02T00:00:00.000Z'),created_at:now,updated_at:now,completed_at:null,obsolete_at:null};
    class ClaimSql implements SqlClient{calls:string[]=[];query<Row extends Record<string,unknown>>(statement:string):Promise<{rows:Row[]}>{this.calls.push(statement);if(statement.includes('clock_timestamp()'))return Promise.resolve({rows:[{database_time:now}] as Row[]});if(statement.includes("from app.agent_tasks t where t.state='pending'"))return Promise.resolve({rows:[row] as Row[]});if(statement.includes('coalesce(max(sequence)'))return Promise.resolve({rows:[{sequence:1}] as Row[]});if(statement.startsWith('update app.agent_tasks'))return Promise.resolve({rows:[{id:row.id}] as Row[]});return Promise.resolve({rows:[]});}transaction<T>(operation:(sql:SqlClient)=>Promise<T>):Promise<T>{return operation(this);}}
    const sql=new ClaimSql();let bound:SqlClient|undefined;let admitted:unknown;const admission={bind(db:SqlClient){bound=db;return this;},authorizeTaskClaim(input:unknown){admitted=input;return Promise.resolve({allowed:true});}};
    await expect(new AgentTaskStore(sql,admission).claim({kind:'mastra'},'worker')).resolves.toMatchObject({task:{state:'leased'}});expect(bound).toBe(sql);expect(admitted).toMatchObject({userId:id(3),taskId:id(1)});expect(sql.calls.findIndex(x=>x.includes('agent_task_delivery_attempts'))).toBeLessThan(sql.calls.findIndex(x=>x.startsWith('update app.agent_tasks')));
  });
  it.skipIf(!process.env.DATABASE_URL)('rejects an authority snapshot owned by another tenant',async()=>{
    const url=process.env.DATABASE_URL;if(!url)throw new Error('DATABASE_URL is required');await withPostgresSchemas(url,async sql=>{
      const seed=async()=>{const user=randomUUID(),account=randomUUID(),assignment=randomUUID(),grant=randomUUID();await sql.begin(async tx=>{await tx`insert into app.users(id,email,password_hash) values(${user},${`${user}@example.test`},'hash')`;await tx`insert into app.accounts(id,user_id,provider,provider_account_id,email,state) values(${account},${user},'gmail',${account},${`${account}@example.test`},'ready')`;await tx`insert into app.user_accounts(user_id,account_id) values(${user},${account})`;await tx`insert into app.mailbox_manager_assignments(id,user_id,account_id,manager_kind,automatic_processing_enabled) values(${assignment},${user},${account},'mastra',true)`;await tx`insert into app.agent_capability_grants(id,user_id,account_id,manager_kind,capabilities,invocation_modes,state,approved_at) values(${grant},${user},${account},'mastra',array['mail.read']::text[],array['automatic']::text[],'active',now())`;});return{user,account,assignment,grant};};
      const a=await seed(),b=await seed(),activity=randomUUID();await sql`insert into app.agent_activities(id,user_id,account_id,kind,correlation_id,state,revision) values(${activity},${a.user},${a.account},'interactive_request','cross-tenant-test','open',1)`;
      await expect(sql`insert into app.agent_tasks(id,enqueue_key,activity_id,user_id,account_id,manager_kind,assignment_id,assignment_revision,grant_id,grant_revision,safety_revision,state,pending_reason,version,attempt_count,max_attempts,lease_generation,available_at,deadline_at) values(${randomUUID()},${`cross:${activity}`},${activity},${a.user},${a.account},'mastra',${b.assignment},1,${b.grant},1,1,'pending','initial',1,0,5,0,now(),now()+interval '1 hour')`).rejects.toThrow('agent task authority identity mismatch');
    });
  });

});
