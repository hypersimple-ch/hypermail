import type { SqlClient } from '../activity/postgres-repository.js';
import type { DraftRecord, DraftScope } from './contracts.js';

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const stamp = (value: unknown): string => value instanceof Date ? value.toISOString() : text(value);
const recipients = (value: unknown): DraftRecord['recipients'] => {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item): DraftRecord['recipients'] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const kind = record['kind']; const address = record['address'];
    return (kind === 'to' || kind === 'cc' || kind === 'bcc') && typeof address === 'string' ? [{ kind, address }] : [];
  });
};

/** Read model for browser drafts; account scope is enforced in SQL. */
export class PostgresDraftList {
  constructor(private readonly sql: SqlClient) {}
  async list(scope: DraftScope): Promise<readonly DraftRecord[]> {
    const result = await this.sql.query(`SELECT id, account_id, source_message_id, created_by, state, recipients, subject, body, body_format, version, created_at, updated_at FROM app.drafts WHERE account_id = ANY($1::uuid[]) ORDER BY updated_at DESC, id DESC`, [scope.accountIds]);
    return result.rows.map((row) => ({ id: text(row['id']), accountId: text(row['account_id']), sourceMessageId: row['source_message_id'] == null ? null : text(row['source_message_id']), createdBy: text(row['created_by']) as DraftRecord['createdBy'], state: text(row['state']) as DraftRecord['state'], recipients: recipients(row['recipients']), subject: text(row['subject']), body: text(row['body']), bodyFormat: row['body_format'] === 'html' ? 'html' : 'markdown', version: Number(row['version']), createdAt: stamp(row['created_at']), updatedAt: stamp(row['updated_at']) }));
  }
}
