import type { DraftScope, DraftSource, DraftSourceReader } from './contracts.js';
import type { SqlClient } from '../activity/postgres-repository.js';

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const stamp = (value: unknown): string => value instanceof Date ? value.toISOString() : text(value);
const sender = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const address = (value as Record<string, unknown>)['address'];
    if (typeof address === 'string') return address;
  }
  return '';
};

/** Reads quote context only from the local, account-scoped message projection. */
export class PostgresDraftSourceReader implements DraftSourceReader {
  constructor(private readonly sql: SqlClient) {}

  async read(scope: DraftScope, accountId: string, sourceMessageId: string): Promise<DraftSource | null> {
    if (!scope.accountIds.includes(accountId)) return null;
    const result = await this.sql.query(
      `SELECT m.id, m.account_id, m.sender, m.received_at, m.subject, COALESCE(b.text_body, '') AS body FROM app.messages m LEFT JOIN app.message_bodies b ON b.message_id = m.id WHERE m.id = $1::uuid AND m.account_id = $2::uuid AND m.account_id = ANY($3::uuid[])`,
      [sourceMessageId, accountId, scope.accountIds],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { id: text(row['id']), accountId: text(row['account_id']), from: sender(row['sender']), sentAt: stamp(row['received_at']), subject: text(row['subject']), body: text(row['body']) };
  }
}
