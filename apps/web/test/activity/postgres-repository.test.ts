import { describe, expect, it } from 'vitest';
import { PostgresActivityRepository, type SqlClient, type SqlQueryResult, type SqlRow } from '../../src/activity/index.js';

const scope = { subjectId: 'person-1', accountIds: ['account-a'] } as const;
const row = (overrides: SqlRow = {}): SqlRow => ({
  id: 'activity-1', account_id: 'account-a', message_id: 'message-1', state: 'handled', version: 2,
  created_at: '2025-01-02T00:00:00.000Z', updated_at: '2025-01-02T01:00:00.000Z', title: 'Subject', account_label: 'Personal', message_label: 'Subject',
  question_prompt: null, question_state: null, failure_code: null, failure_message: null, retrying: false, job_state: 'succeeded', timeline: [], ...overrides,
});

class RecordingSql implements SqlClient {
  readonly calls: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
  constructor(private readonly responses: readonly SqlQueryResult[]) {}
  query<Row extends SqlRow = SqlRow>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, values });
    return Promise.resolve((this.responses[this.calls.length - 1] ?? { rows: [] }) as SqlQueryResult<Row>);
  }
  transaction<T>(work: (client: SqlClient) => Promise<T>): Promise<T> { return work(this); }
}

describe('PostgresActivityRepository', () => {
  it('uses account scope, all four database filter semantics, bounded search, and a created_at/id cursor', async () => {
    const db = new RecordingSql([
      { rows: [{ new_count: 2, questions_count: 1, failed_count: 1, history_count: 3 }] },
      { rows: [row({ id: 'z', created_at: '2025-01-02T00:00:00.000Z' }), row({ id: 'a', created_at: '2025-01-02T00:00:00.000Z' })] },
    ]);
    const repository = new PostgresActivityRepository(db);
    const page = await repository.list(scope, { filter: 'history', accountId: 'account-a', search: 'x'.repeat(130), cursor: encodeURIComponent('2025-01-03T00:00:00.000Z|cursor-id'), limit: 1 });
    expect(page.counts).toEqual({ new: 2, questions: 1, failed: 1, history: 3 });
    expect(page.nextCursor).toBe(encodeURIComponent('2025-01-02T00:00:00.000Z|z'));
    const list = db.calls[1] ?? { text: '', values: [] };
    expect(list.text).toContain("a.account_id = ANY($1::uuid[])");
    expect(list.text).toContain("a.state = 'acknowledged'");
    expect(list.text).toContain('(a.created_at, a.id) <');
    expect(list.text).toContain('ORDER BY a.created_at DESC, a.id DESC');
    expect(list.values).toContain(scope.accountIds);
    expect(list.values).toContain(`%${'x'.repeat(120)}%`);
  });

  it('maps each filter to its persisted state semantics', async () => {
    const cases = [
      ['new', "(a.state = 'new' OR a.state = 'handled')"],
      ['questions', "a.state = 'waiting_question'"],
      ['failed', "a.state = 'failed'"],
      ['history', "a.state = 'acknowledged'"],
    ] as const;
    for (const [filter, predicate] of cases) {
      const db = new RecordingSql([{ rows: [] }, { rows: [] }]);
      await new PostgresActivityRepository(db).list(scope, { filter, limit: 1 });
      expect((db.calls[1] ?? { text: '' }).text).toContain(predicate);
    }
  });

  it('uses version compare-and-swap, persists the retry marker, and records an audit in the transaction', async () => {
    const db = new RecordingSql([
      { rows: [row({ state: 'failed', version: 1, failure_code: 'SYNC', retrying: false })] },
      { rows: [{ version: 2 }] }, { rows: [] }, { rows: [] }, { rows: [row({ state: 'new', version: 2, failure_code: 'SYNC', retrying: true, job_state: 'pending' })] },
    ]);
    const result = await new PostgresActivityRepository(db).requestRetry(scope, 'activity-1', 1);
    expect(result).toMatchObject({ kind: 'updated', activity: { state: 'new', version: 2, jobState: 'pending' } });
    const lock = db.calls[0] ?? { text: '', values: [] };
    const update = db.calls[1] ?? { text: '', values: [] };
    const enqueue = db.calls[2] ?? { text: '', values: [] };
    const audit = db.calls[3] ?? { text: '', values: [] };
    expect(lock.text).toContain('FOR UPDATE');
    expect(update.text).toContain('version = $3');
    expect(enqueue.text).toContain('INSERT INTO app.agent_jobs');
    expect(enqueue.text).toContain("state = 'pending'");
    expect(audit.text).toContain('INSERT INTO app.audits');
    expect(audit.values).toContain('activity.retry_requested');
  });

  it('blocks acknowledgement from the transaction lock when retry work exists', async () => {
    const db = new RecordingSql([{ rows: [row({ version: 1, retrying: true })] }]);
    const result = await new PostgresActivityRepository(db).acknowledge(scope, 'activity-1', 1);
    expect(result).toEqual({ kind: 'blocked', reason: 'Wait for the failed or retrying work to finish before acknowledging.' });
    expect(db.calls).toHaveLength(1);
    const lock = db.calls[0] ?? { text: '', values: [] };
    expect(lock.text).toContain("q.state = 'open'");
    expect(lock.text).toContain("j.state IN ('pending', 'running')");
    expect(lock.text).toContain('FOR UPDATE');
  });
});
