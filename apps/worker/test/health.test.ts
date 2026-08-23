import { describe, expect, it } from 'vitest';
import { liveness, readiness } from '../src/health.js';

describe('worker health contract', () => {
  it('is live without probing dependencies', () => {
    expect(liveness()).toEqual({ status: 'ok' });
  });

  it('reports every unavailable operational dependency without details', () => {
    expect(readiness({ database: false, queue: false, hypermail: true, hindsight: false, scheduler: false, model: true, notifications: true, policy: true })).toEqual({
      status: 'not_ready',
      dependencies: ['database', 'queue', 'hindsight', 'scheduler'],
    });
  });

  it('reports ready when every required runtime capability is available', () => {
    expect(readiness({ database: true, queue: true, hypermail: true, hindsight: true, scheduler: true, model: true, notifications: true, policy: true })).toEqual({
      status: 'ready',
      dependencies: [],
    });
  });
});
