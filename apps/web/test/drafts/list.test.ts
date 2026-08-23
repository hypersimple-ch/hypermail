import { describe, expect, it, vi } from 'vitest';
import { PostgresDraftList } from '../../src/drafts/list.js';

describe('PostgresDraftList', () => {
  it('projects the persisted format and defaults legacy rows to markdown', async () => {
    const base = { id: 'd', account_id: 'a', source_message_id: null, created_by: 'user', state: 'editing', recipients: [], subject: '', body: '', version: 1, created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z' };
    const query = vi.fn(() => Promise.resolve({ rows: [{ ...base, body_format: 'html' }, base] }));
    const drafts = await new PostgresDraftList({ query } as never).list({ subjectId: 'u', accountIds: ['a'] });
    expect(drafts.map((draft) => draft.bodyFormat)).toEqual(['html', 'markdown']);
  });

  it('queries drafts only through the authenticated account scope', async () => {
    const query = vi.fn(() => Promise.resolve({ rows: [] }));
    await new PostgresDraftList({ query } as never).list({ subjectId: 'u', accountIds: ['00000000-0000-4000-8000-000000000001'] });
    const [statement, values] = query.mock.calls[0] as [string, readonly (readonly string[])[]];
    expect(statement).toContain('account_id = ANY($1::uuid[])'); expect(values).toEqual([['00000000-0000-4000-8000-000000000001']]);
  });
});
