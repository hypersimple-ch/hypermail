import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  GLOBAL,
  createApp,
  recallOwnedThread,
} from '../src/proof.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://mastra:mastra@localhost:54329/mastra_proof';

function userMessage(text: string, threadId: string, resourceId: string) {
  return {
    id: randomUUID(),
    role: 'user' as const,
    content: { format: 2 as const, parts: [{ type: 'text' as const, text }] },
    threadId,
    resourceId,
    createdAt: new Date(),
  };
}

async function withApp(t: test.TestContext) {
  const app = createApp(databaseUrl);
  try {
    await app.storage.init();
  } catch (error) {
    t.skip(`PostgreSQL unavailable at ${databaseUrl}; start it with npm run db:up (${String(error)})`);
    return undefined;
  }
  return app;
}

test('PostgresStore scopes account and global message memory and supports source-message correction/reset', async (t) => {
  const app = await withApp(t);
  if (!app) return;
  const { memory, storage } = app;

  const suffix = randomUUID();
  const aliceThread = `alice-${suffix}`;
  const bobThread = `bob-${suffix}`;
  const globalThread = `global-${suffix}`;

  try {
    await memory.createThread({ threadId: aliceThread, resourceId: ACCOUNT_A });
    await memory.createThread({ threadId: bobThread, resourceId: ACCOUNT_B });
    await memory.createThread({ threadId: globalThread, resourceId: GLOBAL });

    await memory.saveMessages({
      messages: [userMessage('alice-private: bronze', aliceThread, ACCOUNT_A)],
    });
    await memory.saveMessages({
      messages: [userMessage('bob-private: silver', bobThread, ACCOUNT_B)],
    });
    await memory.saveMessages({
      messages: [userMessage('global-policy: public', globalThread, GLOBAL)],
    });

    const alice = await recallOwnedThread(memory, aliceThread, ACCOUNT_A);
    const bob = await recallOwnedThread(memory, bobThread, ACCOUNT_B);
    const global = await recallOwnedThread(memory, globalThread, GLOBAL);
    await assert.rejects(
      recallOwnedThread(memory, aliceThread, ACCOUNT_B),
      /does not own thread/,
    );
    assert.match(JSON.stringify(alice.messages), /alice-private: bronze/);
    assert.doesNotMatch(JSON.stringify(alice.messages), /bob-private: silver|global-policy: public/);
    assert.match(JSON.stringify(bob.messages), /bob-private: silver/);
    assert.doesNotMatch(JSON.stringify(bob.messages), /alice-private: bronze|global-policy: public/);
    assert.match(JSON.stringify(global.messages), /global-policy: public/);
    assert.doesNotMatch(JSON.stringify(global.messages), /alice-private: bronze|bob-private: silver/);

    await memory.deleteMessages(alice.messages.map((message) => message.id));
    await memory.saveMessages({
      messages: [userMessage('alice-private: corrected-gold', aliceThread, ACCOUNT_A)],
    });
    const corrected = await recallOwnedThread(memory, aliceThread, ACCOUNT_A);
    assert.doesNotMatch(JSON.stringify(corrected.messages), /bronze/);
    assert.match(JSON.stringify(corrected.messages), /corrected-gold/);

    await memory.deleteMessages(corrected.messages.map((message) => message.id));
    const reset = await recallOwnedThread(memory, aliceThread, ACCOUNT_A);
    assert.equal(reset.messages.length, 0);
  } finally {
    await storage.close();
  }
});

test('workflow snapshot survives app recreation and resumes typed approval input', async (t) => {
  const first = await withApp(t);
  if (!first) return;
  const requestId = `request-${randomUUID()}`;
  let runId: string;

  try {
    const workflow = first.mastra.getWorkflow('approvalWorkflow');
    const run = await workflow.createRun();
    runId = run.runId;
    const suspended = await run.start({ inputData: { requestId } });
    assert.equal(suspended.status, 'suspended');
  } finally {
    await first.storage.close();
  }

  const restarted = await withApp(t);
  if (!restarted) return;
  try {
    const workflow = restarted.mastra.getWorkflow('approvalWorkflow');
    const persisted = await workflow.getWorkflowRunById(runId!);
    assert.equal(persisted?.status, 'suspended');
    const recoveredRun = await workflow.createRun({ runId: runId! });
    const result = await recoveredRun.resume({ step: restarted.approvalStep, resumeData: { approved: true } });
    assert.equal(result.status, 'success');
    assert.match(JSON.stringify(result), new RegExp(`${requestId}:approved`));
  } finally {
    await restarted.storage.close();
  }
});
