import { describe, expect, it } from 'vitest';
import type { ManagedSqlClient } from '@hypermail/db';
import type { HypermailReadClient } from '@hypermail/hypermail';
import type { TriageInput } from '@hypermail/agent';
import { DeliverAgentConsumer, PostgresAgentJobStore, composeWorkerRuntime, createModel } from '../src/production.js';
import { parseWorkerEnvironment } from '../src/runtime.js';

const environment = () => parseWorkerEnvironment({
  DATABASE_URL: 'postgresql://localhost/hypermail', HYPERMAIL_URL: 'https://hypermail.example/mcp', HYPERMAIL_KEY: 'a'.repeat(16), HYPERMAIL_PROTOCOL_VERSION: '2025-03-26',
  MODEL_PROVIDER: 'openai', MODEL_NAME: 'test', MODEL_API_KEY: 'b'.repeat(16), VAPID_SUBJECT: 'mailto:ops@example.test', VAPID_PUBLIC_KEY: 'c'.repeat(16), VAPID_PRIVATE_KEY: 'd'.repeat(16), PUSH_SUBSCRIPTION_ENCRYPTION_KEY: 'e'.repeat(32), AGENT_GLOBAL_CONSTRAINTS: 'Never send mail.', HEALTH_PORT: 31_002,
});
const job = { userId: '00000000-0000-4000-8000-000000000004', id: 'job', activityId: '00000000-0000-4000-8000-000000000001', accountId: '00000000-0000-4000-8000-000000000002', accountEmail: 'account@example.test', messageId: '00000000-0000-4000-8000-000000000003', providerMessageId: 'provider-id', sender: 'Sender', subject: 'Subject', receivedAt: '2025-01-01T00:00:00.000Z', attachments: [{ filename: 'stored.pdf', mediaType: 'application/pdf', sizeBytes: 3 }], attempt: 1 } as const;

describe('production composition', () => {
  it('starts with injected resources and a model adapter that is ready without a probe request', async () => {
    const calls: string[] = [];
    const database: ManagedSqlClient = { query: () => Promise.resolve({ rows: [] }), transaction: async <T>(operation: (client: ManagedSqlClient) => Promise<T>) => operation(database), close: () => { calls.push('database-close'); return Promise.resolve(); } };
    const boss = { start: () => { calls.push('boss-start'); return Promise.resolve(); }, createQueue: (name: string) => { calls.push(`queue:${name}`); return Promise.resolve(); }, stop: () => { calls.push('boss-stop'); return Promise.resolve(); }, send: () => Promise.resolve('queue-job'), async work(name: string, handler: (jobs: readonly { data: unknown }[]) => Promise<void>) { calls.push(`work:${name}`); await handler([]); } };
    const hypermail = { initialize: () => { calls.push('hypermail-initialize'); return Promise.resolve(null); }, verifyPolicyContract: () => { calls.push('policy-contract'); return Promise.resolve(); }, establishBaseline: () => Promise.resolve(), pollNewInbox: () => Promise.resolve([]), inbox: () => Promise.resolve({ messages: [] }) };
    const runtime = composeWorkerRuntime(environment(), { createDatabase: () => database, createBoss: () => boss, createHypermail: () => hypermail as unknown as HypermailReadClient, createTriageService: () => ({ triage: () => Promise.resolve({ decision: { state: 'handled', rationale: 'test' } }) }) as never, createNotificationTransport: () => ({ send: () => Promise.resolve({ ok: true }) }), holderId: () => 'test-holder' });
    await runtime.start();
    expect(calls).toEqual(expect.arrayContaining(['boss-start', 'work:agent.evaluate', 'work:notification.deliver', 'work:policy.execute', 'hypermail-initialize']));
    expect(calls.filter(call => call === 'hypermail-initialize')).toHaveLength(1);
    expect(runtime.dependencyState).toMatchObject({ database: true, queue: true, hypermail: true, model: true, notifications: true, policy: true });
    await runtime.shutdown();
    expect(calls).toEqual(expect.arrayContaining(['boss-stop', 'database-close']));
  });

  it('uses the legacy single-owner Hypermail route only in local development', () => {
    const database: ManagedSqlClient={query:()=>Promise.resolve({rows:[]}),transaction:async<T>(work:(client:ManagedSqlClient)=>Promise<T>)=>work(database),close:()=>Promise.resolve()};
    const boss={start:()=>Promise.resolve(),createQueue:()=>Promise.resolve(),stop:()=>Promise.resolve(),send:()=>Promise.resolve('job'),work:()=>Promise.resolve()};
    const factories={createDatabase:()=>database,createBoss:()=>boss,createTriageService:()=>({triage:()=>Promise.resolve({decision:{state:'handled',rationale:'test'}})}) as never,createNotificationTransport:()=>({send:()=>Promise.resolve({ok:true})}),holderId:()=> 'holder'};
    const local=environment();expect(()=>composeWorkerRuntime(local,factories)).not.toThrow();
    expect(()=>composeWorkerRuntime({...local,NODE_ENV:'production'},factories)).toThrow('HYPERMAIL_TENANT_ROUTES_REQUIRED');
  });

  it.each(['codex-cli', 'openai', 'anthropic', 'google'] as const)('constructs the configured %s provider without a request', (MODEL_PROVIDER) => {
    expect(createModel({ MODEL_PROVIDER, MODEL_NAME: 'test-model', ...(MODEL_PROVIDER === 'codex-cli' ? {} : { MODEL_API_KEY: 'test-key' }) })).toBeDefined();
  });

  it('maps only fetched text and durable attachment metadata into triage', async () => {
    const inputs: TriageInput[] = []; 
    const consumer = new DeliverAgentConsumer(
      { clientForUser: () => ({ initialize: () => Promise.resolve(null), readMessage: () => Promise.resolve({ body: 'body only', attachments: [{ filename: 'ignored.bin', bytes: 'secret' }] }) }) },
      { triage: (input: TriageInput) => { inputs.push(input); return Promise.resolve({ decision: { state: 'handled', rationale: 'ok' } }); } } as never,
      { cacheBody: () => Promise.resolve(), failAdapter: () => Promise.resolve() }, 'Never mutate mail.',
    );
    await consumer.evaluate({ ...job, attachments: [...job.attachments] });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.email.bodyText).toBe('body only');
    expect(inputs[0]?.email.attachments).toEqual([...job.attachments]);
    expect(JSON.stringify(inputs)).not.toContain('secret');
  });

  it('does not claim duplicate terminal jobs and marks pre-triage adapter failures failed', async () => {
    const queries: string[] = [];
    const database = { query: (sql: string) => { queries.push(sql); return Promise.resolve({ rows: [] }); }, transaction: async (operation: (client: never) => Promise<void>) => operation(database) } as unknown as ManagedSqlClient;
    expect(await new PostgresAgentJobStore(database).claim('job', job.userId)).toBeNull();
    expect(queries[0]).toContain("state IN ('pending', 'running')");
    const failures: string[] = [];
    const consumer = new DeliverAgentConsumer(
      { clientForUser: () => ({ initialize: () => Promise.resolve(null), readMessage: () => Promise.reject(new Error('unavailable')) }) },
      { triage: () => Promise.resolve({}) } as never,
      { cacheBody: () => Promise.resolve(), failAdapter: (_job, code) => { failures.push(code); return Promise.resolve(); } }, 'Never mutate mail.',
    );
    await expect(consumer.evaluate({ ...job, attachments: [...job.attachments] })).rejects.toThrow('unavailable');
    expect(failures).toEqual(['AGENT_INPUT_UNAVAILABLE']);
  });
  it.each([
    ['agent_connection', 'EXTERNAL_MANAGER_DELIVERY_REQUIRED'],
    ['none', 'NO_MANAGER_ASSIGNED'],
    ['mastra', 'CANONICAL_AUTHORITY_UNAVAILABLE'],
  ])('fails closed for %s without handing work to embedded Mastra', async (managerKind, reason) => {
    const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const row = { ...job, jobState: 'pending', runId: null, assignmentId: job.accountId,
      assignmentRevision: 1, managerKind, automaticEnabled: true, grantId: null, grantRevision: null,
      grantState: null, grantModes: null, grantCapabilities: null, safetyRevision: 1,
      safetyModes: ['automatic'], safetyCapabilities: ['mail.read'] };
    const database = { query: (sql: string, values?: readonly unknown[]) => {
      queries.push({ sql, values }); return Promise.resolve({ rows: sql.includes('select j.id') ? [row] : [] });
    }, transaction: async <T>(operation: (client: ManagedSqlClient) => Promise<T>) => operation(database) } as unknown as ManagedSqlClient;
    expect(await new PostgresAgentJobStore(database).claim(job.id, job.userId)).toBeNull();
    expect(queries.some(query => query.values?.includes(reason))).toBe(true);
    expect(queries.some(query => query.sql.includes('insert into app.agent_runs'))).toBe(false);
  });

  it('claims reviewed automatic Mastra authority once and links one deterministic canonical Run', async () => {
    const queries: string[] = [];
    const row = { ...job, jobState: 'pending', runId: null, assignmentId: job.accountId,
      assignmentRevision: 1, managerKind: 'mastra', automaticEnabled: true, grantId: job.messageId,
      grantRevision: 1, grantState: 'active', grantModes: ['automatic'], grantCapabilities: ['mail.read'],
      safetyRevision: 1, safetyModes: ['automatic'], safetyCapabilities: ['mail.read'] };
    const database = { query: (sql: string) => { queries.push(sql);
      return Promise.resolve({ rows: sql.includes('select j.id') ? [row] : [] }); },
      transaction: async <T>(operation: (client: ManagedSqlClient) => Promise<T>) => operation(database) } as unknown as ManagedSqlClient;
    const claimed = await new PostgresAgentJobStore(database).claim(job.id, job.userId);
    expect(claimed?.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(queries.filter(query => query.includes('insert into app.agent_runs'))).toHaveLength(1);
    expect(queries.some(query => query.includes("'running',now(),now()") && query.includes('on conflict(id) do nothing'))).toBe(true);
  });

});
