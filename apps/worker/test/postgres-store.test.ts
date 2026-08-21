/* eslint-disable @typescript-eslint/require-await */
import { describe,expect,it } from 'vitest';
import { PostgresIngestionStore,type SqlClient,type SqlResult } from '../src/postgres-store.js';

class CaptureSql implements SqlClient {
  readonly statements:string[]=[];
  async query<Row extends Record<string,unknown>>(statement:string):Promise<SqlResult<Row>>{this.statements.push(statement);return {rows:(statement.includes('select user_id from app.accounts')?[{user_id:'00000000-0000-4000-8000-000000000002'}]:[]) as Row[]};}
  async transaction<T>(operation:(sql:SqlClient)=>Promise<T>):Promise<T>{return operation(this);}
}

describe('Postgres ingestion execution source',()=>{
  it('does not create deliverable canonical Tasks while only the legacy executor is mounted',async()=>{
    const sql=new CaptureSql();const store=new PostgresIngestionStore(sql);
    await store.recordArrival({accountId:'00000000-0000-4000-8000-000000000001',observedAt:new Date('2026-01-01T00:00:00Z'),message:{id:'provider-1',account:'owner@example.test',subject:'subject'}});
    const statement=sql.statements.at(-1)??'';expect(statement).toContain('insert into app.agent_jobs');expect(statement).not.toContain('insert into app.agent_tasks');expect(statement).not.toContain('insert into app.agent_task_outbox');expect(statement).not.toContain('insert into app.agent_task_blocks');
  });
});
