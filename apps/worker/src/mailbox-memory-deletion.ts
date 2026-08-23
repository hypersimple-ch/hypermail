import type { MailboxMemory } from '@hypermail/agent';
import type { ManagedSqlClient } from '@hypermail/db';
import { mailboxBankId } from './hindsight-memory.js';

export type PermanentMailboxMemoryDeletion = Readonly<{ userId: string; mailboxId: string; alreadyDeleted: boolean }>;

/**
 * Explicit operator boundary for permanent Hindsight deletion.
 * The worker must be stopped before calling it so an already claimed retain cannot recreate the bank.
 * PostgreSQL history remains canonical: completed events are untouched and replayable events are cancelled/minimized.
 */
export async function permanentlyDeleteMailboxMemory(input: Readonly<{
  database: ManagedSqlClient;
  memory: Pick<MailboxMemory, 'deleteMailbox'>;
  userId: string;
  mailboxId: string;
  workerStopped: boolean;
}>): Promise<PermanentMailboxMemoryDeletion> {
  if (!input.workerStopped) throw new Error('MAILBOX_MEMORY_DELETE_REQUIRES_STOPPED_WORKER');
  const bankId = mailboxBankId({ userId: input.userId, mailboxId: input.mailboxId });
  const prepared = await input.database.transaction(async (database) => {
    const account = (await database.query<{ state: string }>(`select a.state from app.accounts a
      join app.user_accounts ua on ua.account_id=a.id and ua.user_id=a.user_id
      where a.id=$1::uuid and a.user_id=$2::uuid for update`, [input.mailboxId, input.userId])).rows[0];
    if (!account) throw new Error('MAILBOX_MEMORY_DELETE_SCOPE_NOT_FOUND');
    const completed = (await database.query<{ found: boolean }>(`select exists(select 1 from app.audits
      where actor_type='operator' and actor_id=$1::text and account_id=$2::uuid
        and event='mailbox_memory.deleted' and correlation_id=$3::text) as found`,
    [input.userId, input.mailboxId, `mailbox-memory-delete:${input.mailboxId}`])).rows[0]?.found === true;
    if (completed) return { alreadyDeleted: true, inFlight: 0 };
    await database.query(`update app.accounts set state='disabled',updated_at=clock_timestamp()
      where id=$1::uuid and user_id=$2::uuid`, [input.mailboxId, input.userId]);
    await database.query(`update app.agent_jobs j set state='failed',last_error_code='OWNER_MEMORY_DELETION',
      unavailable_reason='OWNER_MEMORY_DELETION',updated_at=clock_timestamp() from app.activities a
      where j.activity_id=a.id and a.account_id=$1::uuid and j.state in ('pending','running','suspended')`, [input.mailboxId]);
    await database.query(`update app.agent_runs set state='completed',outcome='failed',error_code='OWNER_MEMORY_DELETION',
      completed_at=clock_timestamp() where user_id=$1::uuid and account_id=$2::uuid and state in ('created','running')`,
    [input.userId, input.mailboxId]);
    await database.query(`update app.agent_authorized_actions set state='cancelled',error_code='OWNER_MEMORY_DELETION',
      completed_at=clock_timestamp() where user_id=$1::uuid and account_id=$2::uuid and state in ('authorized','executing','verifying')`,
    [input.userId, input.mailboxId]);
    await database.query(`insert into app.audits(actor_type,actor_id,account_id,event,correlation_id,metadata)
      values('operator',$1,$2::uuid,'mailbox_memory.delete_requested',$3,$4::jsonb)`,
    [input.userId, input.mailboxId, `mailbox-memory-delete:${input.mailboxId}`, { bankId }]);
    await database.query(`update app.mailbox_memory_events set state='cancelled',content_payload=null,
      last_error_code='OWNER_MEMORY_DELETION',last_error_metadata='{}'::jsonb,
      cancelled_at=clock_timestamp(),claim_worker=null,claimed_at=null,claim_expires_at=null,updated_at=clock_timestamp()
      where user_id=$1::uuid and account_id=$2::uuid and state in ('pending','processing')`, [input.userId, input.mailboxId]);
    return { alreadyDeleted: false };
  });
  if (prepared.alreadyDeleted) return { userId: input.userId, mailboxId: input.mailboxId, alreadyDeleted: true };
  await input.memory.deleteMailbox({ userId: input.userId, mailboxId: input.mailboxId });
  await input.database.transaction(async (database) => {
    await database.query(`insert into app.audits(actor_type,actor_id,account_id,event,correlation_id,metadata)
      values('operator',$1,$2::uuid,'mailbox_memory.deleted',$3,$4::jsonb)`,
    [input.userId, input.mailboxId, `mailbox-memory-delete:${input.mailboxId}`, { bankId }]);
  });
  return { userId: input.userId, mailboxId: input.mailboxId, alreadyDeleted: false };
}
