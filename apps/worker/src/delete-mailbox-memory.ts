import { createPostgresClient } from '@hypermail/db';
import { createHindsightMailboxMemory, hindsightConfigurationFromWorkerEnvironment } from './hindsight-memory.js';
import { permanentlyDeleteMailboxMemory } from './mailbox-memory-deletion.js';
import { parseWorkerEnvironment } from './runtime.js';

const [userId, mailboxId] = process.argv.slice(2);
if (!userId || !mailboxId) throw new Error('Usage: memory:delete <User UUID> <Mailbox UUID>');
const environment = parseWorkerEnvironment(process.env);
const database = createPostgresClient(environment.DATABASE_URL);
try {
  const memory = createHindsightMailboxMemory(hindsightConfigurationFromWorkerEnvironment(environment));
  const result = await permanentlyDeleteMailboxMemory({ database, memory, userId, mailboxId,
    workerStopped: process.env['MEMORY_DELETE_WORKER_STOPPED'] === '1' });
  process.stdout.write(`${JSON.stringify({ status: 'deleted', userId: result.userId, mailboxId: result.mailboxId, alreadyDeleted: result.alreadyDeleted })}\n`);
} finally {
  await database.close();
}
