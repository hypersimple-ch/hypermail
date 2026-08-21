import { describe, expect, it } from 'vitest';
import { actionableAlerts, createStructuredLogger, OperationalMetrics, PayloadFreeTracing, redact, systemHealth } from '../src/index.js';

describe('safe structured observability', () => {
  it('redacts nested sensitive values, errors, and URLs', () => {
    const error = new Error('provider failed https://user:password@db.example/x?token=abc');
    const result = redact({ body: 'mail body', nested: { message: 'mail body', preview: 'snippet', attachmentName: 'taxes.pdf', senderEmail: 'owner@example.test', url: 'https://example.test/?token=secret' }, error, ordinary: 'contact owner@example.test' }) as Record<string, unknown>;
    expect(result['body']).toBe('[redacted]');
    expect(result['ordinary']).toBe('contact [redacted-email]');
    expect(JSON.stringify(result)).not.toMatch(/mail body|taxes\.pdf|owner@example\.test|db\.example|token=abc|password/);
  });

  it('emits redacted structured records with a correlation ID', () => {
    const records: unknown[] = [];
    createStructuredLogger((record) => records.push(record), () => new Date('2025-01-01T00:00:00Z')).log('error', 'poll.failed', { cookie: 'session', failure: new Error('https://api.example/token') }, 'request-1234');
    expect(records).toEqual([{ timestamp: '2025-01-01T00:00:00.000Z', level: 'error', event: 'poll.failed', correlationId: 'request-1234', fields: {} }]);
    createStructuredLogger((record) => records.push(record)).log('info', 'owner@example.test', {});
    expect(records[1]).toMatchObject({ event: 'invalid_event' });
  });

  it('keeps metrics to fixed operational dimensions and creates actionable alerts', () => {
    const metrics = new OperationalMetrics();
    metrics.increment('poll_cycle', 'failure');
    metrics.increment('push', 'success', 2);
    expect(metrics.snapshot()).toEqual([{ name: 'poll_cycle', outcome: 'failure', value: 1 }, { name: 'push', outcome: 'success', value: 2 }]);
    expect(actionableAlerts([{ name: 'autonomous_action', failed: 2, total: 100 }], false)).toEqual([expect.objectContaining({ name: 'autonomous_action', severity: 'critical' })]);
  });

  it('drops adversarial payloads and high-cardinality dimensions from logs and metrics', () => {
    const records: unknown[] = [];
    const secret = 'quarterly acquisition message body owner@example.test bearer-secret';
    createStructuredLogger((record) => records.push(record)).log('error', 'provider.failed', {
      body: secret, detail: secret, error: new Error(secret), providerKind: secret,
      queue: 'agent.task', count: 1, reasonCode: 'provider',
    }, secret);
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('quarterly');
    expect(serialized).not.toContain('owner@example.test');
    expect(records[0]).toMatchObject({ fields: { queue: 'agent.task', count: 1, reasonCode: 'provider' } });
    expect(records[0]).not.toHaveProperty('correlationId');

    const metrics = new OperationalMetrics();
    metrics.increment('queue_age', 'success', 42);
    metrics.increment('oauth_reuse', 'failure');
    metrics.increment('connection_health', 'unavailable');
    metrics.increment('provider_error', 'failure');
    metrics.increment('authorization_denial', 'failure');
    metrics.increment('quota_denial', 'failure');
    expect(metrics.snapshot()).toHaveLength(6);
    expect(JSON.stringify(metrics.snapshot())).not.toContain(secret);
  });

  it('records only fixed payload-free trace points', () => {
    const traces = new PayloadFreeTracing();
    traces.record('queue.consume','ok',12);
    expect(traces.snapshot()).toEqual([{ name:'queue.consume',status:'ok',durationMs:12 }]);
    expect(JSON.stringify(traces.snapshot())).not.toMatch(/body|token|email|attachment/);
  });

  it('distinguishes liveness, readiness, and operational degradation without details', () => {
    expect(systemHealth({ database: true, queue: false, hypermail: true, scheduler: true }, ['polling', 'polling'])).toEqual({ liveness: 'ok', readiness: 'not_ready', degradation: ['polling'] });
  });
});
