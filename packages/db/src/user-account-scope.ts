import type { SqlClient } from './postgres-client.js';

export interface AccountProjection {
  readonly id: string;
  readonly provider: 'microsoft' | 'gmail' | 'imap';
  readonly email: string;
  readonly displayName: string | null;
  readonly state: 'pending' | 'ready' | 'degraded' | 'disabled';
}

/** A validated, credential-free account result from Hypermail. */
export interface ReadyAccountInput {
  readonly provider: 'outlook' | 'gmail' | 'imap';
  readonly email: string;
  readonly displayName?: string;
}

type DatabaseProvider = AccountProjection['provider'];

function normalizeReadyAccount(input: ReadyAccountInput): { provider: DatabaseProvider; email: string; displayName: string | null } {
  if (typeof input.provider !== 'string') throw new RangeError('Unsupported account provider.');
  const provider = input.provider.trim().toLowerCase();
  const mappedProvider: DatabaseProvider | undefined = provider === 'outlook' ? 'microsoft' : provider === 'gmail' || provider === 'imap' ? provider : undefined;
  if (!mappedProvider) throw new RangeError('Unsupported account provider.');

  if (typeof input.email !== 'string') throw new RangeError('Invalid account email.');
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new RangeError('Invalid account email.');

  if (input.displayName !== undefined && typeof input.displayName !== 'string') throw new RangeError('Invalid account display name.');
  const displayName = input.displayName?.trim();
  return { provider: mappedProvider, email, displayName: displayName || null };
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

  /**
   * Persists a safe Hypermail account projection and its authenticated owner.
   * Existing identities may only be re-added by their current owner.
   */
  async projectReadyAccount(userId: string, input: ReadyAccountInput): Promise<AccountProjection> {
    if (typeof userId !== 'string') throw new RangeError('Invalid user id.');
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) throw new RangeError('Invalid user id.');
    const account = normalizeReadyAccount(input);

    return this.sql.transaction(async (sql) => {
      const existing = await sql.query<{
        id: string;
        provider: DatabaseProvider;
        provider_account_id: string;
        email: string;
      }>(
        `select id, provider, provider_account_id, email
         from app.accounts
         where (provider = $1 and provider_account_id = $2) or lower(email) = $2
         for update`,
        [account.provider, account.email],
      );
      if (existing.rows.length > 1) throw new Error('Account identity conflict.');

      let accountId: string;
      if (existing.rows[0]) {
        const current = existing.rows[0];
        if (current.provider !== account.provider || current.provider_account_id !== account.email || current.email.toLowerCase() !== account.email) {
          throw new Error('Account identity conflict.');
        }
        accountId = current.id;
      } else {
        const inserted = await sql.query<{ id: string }>(
          `insert into app.accounts (provider, provider_account_id, email, display_name, state)
           values ($1, $2, $3, $4, 'ready')
           returning id`,
          [account.provider, account.email, account.email, account.displayName],
        );
        accountId = inserted.rows[0]?.id ?? (() => { throw new Error('Account projection failed.'); })();
      }

      const owners = await sql.query<{ user_id: string }>(
        `select user_id from app.user_accounts where account_id = $1 for update`,
        [accountId],
      );
      if (owners.rows.some((owner) => owner.user_id !== normalizedUserId)) throw new Error('Account is already linked to another user.');

      await sql.query(
        `update app.accounts set display_name = $2, state = 'ready', updated_at = now() where id = $1`,
        [accountId, account.displayName],
      );
      await sql.query(
        `insert into app.user_accounts (user_id, account_id) values ($1, $2)
         on conflict (user_id, account_id) do nothing`,
        [normalizedUserId, accountId],
      );

      return { id: accountId, provider: account.provider, email: account.email, displayName: account.displayName, state: 'ready' };
    });
  }
}
