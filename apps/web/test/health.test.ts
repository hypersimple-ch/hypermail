import { describe, expect, it } from 'vitest';
import { liveness, readiness } from '../src/health.js';

describe('web health contract', () => {
  it('is live without probing dependencies', () => {
    expect(liveness()).toEqual({ status: 'ok' });
  });

  it('reports only unavailable dependency names', () => {
    expect(readiness({ database: true, hypermail: false })).toEqual({
      status: 'not_ready',
      dependencies: ['hypermail'],
    });
  });

  it('reports ready when all dependencies are available', () => {
    expect(readiness({ database: true, hypermail: true })).toEqual({
      status: 'ready',
      dependencies: [],
    });
  });
});
