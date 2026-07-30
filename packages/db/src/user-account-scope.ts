import type { SqlClient } from './postgres-client.js';

export interface AccountProjection {
  readonly id: string;
  readonly provider: 'microsoft' | 'gmail' | 'imap';
  readonly email: string;
  readonly displayName: string | null;
  readonly state: 'pending' | 'ready' | 'degraded' | 'disabled';
}

/** The only production source for session-to-account authorization. */
export class UserAccountScopeStore {
  constructor(private readonly sql: SqlClient) {}

  async accountIdsForUser(userId: string): Promise<readonly string[]> {
    const result = await this.sql.query<{ account_id: string }>(
      `select account_id from app.user_accounts where user_id = $1 order by account_id`,
      [userId],
    );
    return result.rows.map((row) => row.account_id);
  }

  async accountsForUser(userId: string): Promise<readonly AccountProjection[]> {
    const result = await this.sql.query<{
      id: string;
      provider: AccountProjection['provider'];
      email: string;
      display_name: string | null;
      state: AccountProjection['state'];
    }>(
      `select a.id, a.provider, a.email, a.display_name, a.state
       from app.user_accounts ua
       join app.accounts a on a.id = ua.account_id
       where ua.user_id = $1
       order by lower(coalesce(a.display_name, a.email)), a.id`,
      [userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      email: row.email,
      displayName: row.display_name,
      state: row.state,
    }));
  }

  async ownsAccount(userId: string, accountId: string): Promise<boolean> {
    const result = await this.sql.query<{ owned: boolean }>(
      `select exists(select 1 from app.user_accounts where user_id = $1 and account_id = $2) as owned`,
      [userId, accountId],
    );
    return result.rows[0]?.owned === true;
  }
}
