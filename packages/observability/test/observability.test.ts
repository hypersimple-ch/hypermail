import { describe, expect, it } from 'vitest';
import { actionableAlerts, createStructuredLogger, OperationalMetrics, redact, systemHealth } from '../src/index.js';

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
    expect(records).toEqual([{ timestamp: '2025-01-01T00:00:00.000Z', level: 'error', event: 'poll.failed', correlationId: 'request-1234', fields: { cookie: '[redacted]', failure: { name: 'Error', message: '[redacted-url]' } } }]);
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

  it('distinguishes liveness, readiness, and operational degradation without details', () => {
    expect(systemHealth({ database: true, queue: false, hypermail: true, scheduler: true }, ['polling', 'polling'])).toEqual({ liveness: 'ok', readiness: 'not_ready', degradation: ['polling'] });
  });
});
