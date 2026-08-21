import { describe,expect,it } from 'vitest';
import { PostgresOperationalGuard } from '../src/operational-safety.js';
import type { SqlClient,SqlResult } from '../src/postgres-store.js';

class FakeSql implements SqlClient {
  rate=0; active=0; pending=0; audits:string[]=[];
  async transaction<T>(operation:(client:SqlClient)=>Promise<T>):Promise<T>{ return operation(this); }
  query<Row extends Record<string,unknown>>(statement:string):Promise<SqlResult<Row>> {
    if(statement.includes('pg_advisory_xact_lock')) return Promise.resolve({rows:[{database_time:new Date('2026-01-01T00:00:00Z')}] as Row[]});
    if(statement.includes('SELECT EXISTS')) return Promise.resolve({rows:[{present:false}] as Row[]});
    if(statement.includes("state='leased'")) return Promise.resolve({rows:[{active:this.active}] as Row[]});
    if(statement.includes("state IN ('pending'")) return Promise.resolve({rows:[{pending:this.pending}] as Row[]});
    if(statement.includes('INSERT INTO app.rate_limits')) return Promise.resolve({rows:[{count:++this.rate}] as Row[]});
    if(statement.includes('INSERT INTO app.audits')) { this.audits.push(statement); return Promise.resolve({rows:[]}); }
    throw new Error(`unexpected query: ${statement}`);
  }
}
const key='operational-test-pseudonym-key-at-least-32-bytes';
const limits={tasksPerMinute:2,claimsPerMinute:2,concurrentTasks:1,pendingTasks:2};

describe('per-user operational guard',()=>{
  it('admits within all limits without storing payloads',async()=>{
    const db=new FakeSql(); const guard=new PostgresOperationalGuard(db,limits,key);
    expect(await guard.authorizeTask('00000000-0000-4000-8000-000000000001',new Date())).toEqual({allowed:true});
    expect(db.audits).toHaveLength(0);
  });
  it('fails safely and audits rate, concurrency, and pending quota exhaustion',async()=>{
    const at=new Date('2026-01-01T00:00:00Z');
    const rateDb=new FakeSql(); rateDb.rate=1;
    expect(await new PostgresOperationalGuard(rateDb,{...limits,claimsPerMinute:1},key).authorizeTask('u',at)).toEqual({allowed:false,reason:'claim_rate_limit',databaseTime:at});
    const concurrentDb=new FakeSql(); concurrentDb.active=1;
    expect(await new PostgresOperationalGuard(concurrentDb,limits,key).authorizeTask('u',at)).toEqual({allowed:false,reason:'concurrency',databaseTime:at});
    const quotaDb=new FakeSql(); quotaDb.pending=2;
    expect(await new PostgresOperationalGuard(quotaDb,limits,key).authorizeTaskCreation({userId:'u',accountId:'a',providerMessageId:'m'})).toEqual({allowed:false,reason:'pending_quota',databaseTime:at});
    expect([rateDb,concurrentDb,quotaDb].every(db=>db.audits.length===1)).toBe(true);
  });
  it('validates operator limits',()=>{
    expect(()=>new PostgresOperationalGuard(new FakeSql(),{...limits,tasksPerMinute:0},key)).toThrow(RangeError);
  });
});
