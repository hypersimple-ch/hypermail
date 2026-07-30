import { describe, expect, it, vi } from 'vitest';
import { ClaimingAgentConsumer, DurableNotificationRecovery, parseQueuePayload, parseWorkerEnvironment, requireAutonomousCapability, WorkerRuntime, type BossRuntime, type WorkerEnvironment, type WorkerRuntimeDependencies } from '../src/runtime.js';

const env = (): WorkerEnvironment => parseWorkerEnvironment({
  DATABASE_URL: 'postgresql://localhost/hypermail', HYPERMAIL_URL: 'https://hypermail.example/mcp', HYPERMAIL_KEY: 'a'.repeat(16), HYPERMAIL_PROTOCOL_VERSION: '2025-03-26',
  MODEL_PROVIDER: 'openai', MODEL_NAME: 'test', MODEL_API_KEY: 'b'.repeat(16), VAPID_SUBJECT: 'mailto:ops@example.test', VAPID_PUBLIC_KEY: 'c'.repeat(16), VAPID_PRIVATE_KEY: 'd'.repeat(16), PUSH_SUBSCRIPTION_ENCRYPTION_KEY: 'e'.repeat(32), AGENT_GLOBAL_CONSTRAINTS: 'Never send mail.', HEALTH_PORT: 31_001,
});
class FakeBoss implements BossRuntime {
  readonly handlers = new Map<string, (job: { data: unknown }) => Promise<void>>(); readonly queues: string[] = []; started = false; stopped = false;
  start(): Promise<void> { this.started = true; return Promise.resolve(); }
  createQueue(name: 'agent.evaluate' | 'notification.deliver' | 'policy.execute'): Promise<void> { this.queues.push(name); return Promise.resolve(); }
  stop(): Promise<void> { this.stopped = true; return Promise.resolve(); }
  work(name: 'agent.evaluate' | 'notification.deliver' | 'policy.execute', handler: (job: { data: unknown }) => Promise<void>): Promise<void> { this.handlers.set(name, handler); return Promise.resolve(); }
}
const dependencies = (boss: FakeBoss, calls: string[]): WorkerRuntimeDependencies => ({
  boss, ingestion: { start: () => Promise.resolve(), stop() { calls.push('ingestion-stop'); } }, lifecycle: { start: () => Promise.resolve(), stop() { calls.push('lifecycle-stop'); } },
  dispatchRecovery: { recover() { calls.push('dispatch-recovery'); return Promise.resolve(); } }, notificationRecovery: { recover() { calls.push('notification-recovery'); return Promise.resolve(); } }, policyRecovery: { recover() { calls.push('policy-recovery'); return Promise.resolve(); } },
  agentConsumer: { consume(payload) { calls.push(`agent:${String(payload.jobId)}`); return Promise.resolve(); } }, notificationConsumer: { consume: () => Promise.resolve() }, policyConsumer: { consume: () => Promise.resolve() },
  closeDatabase() { calls.push('database-close'); return Promise.resolve(); }, probes: { database: () => Promise.resolve(true), hypermail: () => Promise.resolve(true) },
});

describe('worker runtime', () => {
  it('fails closed for malformed environment and queue payloads', () => {
    expect(() => parseWorkerEnvironment({})).toThrow('DATABASE_URL');
    expect(() => parseWorkerEnvironment({
      DATABASE_URL: 'postgresql://localhost/hypermail', HYPERMAIL_URL: 'https://hypermail.example/mcp', HYPERMAIL_KEY: 'a'.repeat(16),
      MODEL_PROVIDER: 'openai', MODEL_NAME: 'test', MODEL_API_KEY: 'b'.repeat(16), VAPID_SUBJECT: 'mailto:ops@example.test', VAPID_PUBLIC_KEY: 'c'.repeat(16), VAPID_PRIVATE_KEY: 'd'.repeat(16), PUSH_SUBSCRIPTION_ENCRYPTION_KEY: 'e'.repeat(32), AGENT_GLOBAL_CONSTRAINTS: 'Never send mail.',
    })).toThrow('HYPERMAIL_PROTOCOL_VERSION');
    expect(() => parseQueuePayload('agent.evaluate', { jobId: 'not-a-uuid' })).toThrow('QUEUE_PAYLOAD_INVALID');
    expect(() => parseQueuePayload('agent.evaluate', { jobId: '00000000-0000-4000-8000-000000000000', extra: true })).toThrow('QUEUE_PAYLOAD_INVALID');
  });
  it('claims durable jobs, recovers notifications, and rejects forbidden policy capabilities', async () => {
    const evaluated: string[] = []; const dispatched: string[] = [];
    await new ClaimingAgentConsumer({ claim(jobId) { return Promise.resolve(jobId === '00000000-0000-4000-8000-000000000000' ? jobId : null); } }, { evaluate(job) { evaluated.push(job); return Promise.resolve(); } }).consume({ jobId: '00000000-0000-4000-8000-000000000000' });
    await new DurableNotificationRecovery({ pendingNotificationIds() { return Promise.resolve(['one', 'two']); } }, { dispatch(notificationId) { dispatched.push(notificationId); return Promise.resolve(); } }).recover();
    expect(evaluated).toEqual(['00000000-0000-4000-8000-000000000000']); expect(dispatched).toEqual(['one', 'two']);
    expect(requireAutonomousCapability('archive')).toBe('archive'); expect(() => requireAutonomousCapability('send')).toThrow('POLICY_CAPABILITY_FORBIDDEN');
  });
  it('starts consumers and replay recovery, then closes resources in bounded shutdown order', async () => {
    const boss = new FakeBoss(); const calls: string[] = []; const runtime = new WorkerRuntime(env(), dependencies(boss, calls));
    await runtime.start();
    const agentHandler = boss.handlers.get('agent.evaluate');
    if (!agentHandler) throw new Error('agent.evaluate handler not registered');
    await agentHandler({ data: { jobId: '00000000-0000-4000-8000-000000000000' } });
    expect(boss.started).toBe(true); expect(boss.queues).toEqual(['agent.evaluate', 'notification.deliver', 'policy.execute']); expect(calls).toContain('dispatch-recovery'); expect(calls).toContain('notification-recovery'); expect(calls).toContain('agent:00000000-0000-4000-8000-000000000000');
    await runtime.shutdown();
    expect(boss.stopped).toBe(true); expect(calls.slice(-3)).toEqual(['ingestion-stop', 'lifecycle-stop', 'database-close']);
  });

  it('repeats all durable recoveries on the lifecycle interval', async () => {
    vi.useFakeTimers();
    try {
      const boss = new FakeBoss(); const calls: string[] = [];
      const runtime = new WorkerRuntime({ ...env(), HEALTH_PORT: 31_003, LIFECYCLE_INTERVAL_SECONDS: 1 }, dependencies(boss, calls));
      await runtime.start();
      await vi.advanceTimersByTimeAsync(1_000);
      for (const recovery of ['dispatch-recovery', 'notification-recovery', 'policy-recovery']) expect(calls.filter(call => call === recovery)).toHaveLength(2);
      await runtime.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});
