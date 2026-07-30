import { describe, expect, it, vi } from 'vitest';
import { PostgresDraftList } from '../../src/drafts/list.js';

describe('PostgresDraftList', () => {
  it('queries drafts only through the authenticated account scope', async () => {
    const query = vi.fn(() => Promise.resolve({ rows: [] }));
    await new PostgresDraftList({ query } as never).list({ subjectId: 'u', accountIds: ['00000000-0000-4000-8000-000000000001'] });
    const [statement, values] = query.mock.calls[0] as [string, readonly (readonly string[])[]];
    expect(statement).toContain('account_id = ANY($1::uuid[])'); expect(values).toEqual([['00000000-0000-4000-8000-000000000001']]);
  });
});
