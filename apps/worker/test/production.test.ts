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
const job = { id: 'job', activityId: '00000000-0000-4000-8000-000000000001', accountId: '00000000-0000-4000-8000-000000000002', accountEmail: 'account@example.test', messageId: '00000000-0000-4000-8000-000000000003', providerMessageId: 'provider-id', sender: 'Sender', subject: 'Subject', receivedAt: '2025-01-01T00:00:00.000Z', attachments: [{ filename: 'stored.pdf', mediaType: 'application/pdf', sizeBytes: 3 }], attempt: 1 } as const;

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

  it.each(['codex-cli', 'openai', 'anthropic', 'google'] as const)('constructs the configured %s provider without a request', (MODEL_PROVIDER) => {
    expect(createModel({ MODEL_PROVIDER, MODEL_NAME: 'test-model', ...(MODEL_PROVIDER === 'codex-cli' ? {} : { MODEL_API_KEY: 'test-key' }) })).toBeDefined();
  });

  it('maps only fetched text and durable attachment metadata into triage', async () => {
    const inputs: TriageInput[] = []; 
    const consumer = new DeliverAgentConsumer(
      { initialize: () => Promise.resolve(null), readMessage: () => Promise.resolve({ body: 'body only', attachments: [{ filename: 'ignored.bin', bytes: 'secret' }] }) },
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
    expect(await new PostgresAgentJobStore(database).claim('job')).toBeNull();
    expect(queries[0]).toContain("state IN ('pending', 'running')");
    const failures: string[] = [];
    const consumer = new DeliverAgentConsumer(
      { initialize: () => Promise.resolve(null), readMessage: () => Promise.reject(new Error('unavailable')) },
      { triage: () => Promise.resolve({}) } as never,
      { cacheBody: () => Promise.resolve(), failAdapter: (_job, code) => { failures.push(code); return Promise.resolve(); } }, 'Never mutate mail.',
    );
    await expect(consumer.evaluate({ ...job, attachments: [...job.attachments] })).rejects.toThrow('unavailable');
    expect(failures).toEqual(['AGENT_INPUT_UNAVAILABLE']);
  });
});
