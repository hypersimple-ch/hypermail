import { Mastra } from '@mastra/core';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
import { z } from 'zod';

export const ACCOUNT_A = 'account:proof-alice';
export const ACCOUNT_B = 'account:proof-bob';
export const GLOBAL = 'global:proof';

function createApprovalWorkflow() {
  const approvalStep = createStep({
  id: 'await-user-approval',
  inputSchema: z.object({ requestId: z.string() }),
  resumeSchema: z.object({ approved: z.boolean() }),
  suspendSchema: z.object({ reason: z.string(), requestId: z.string() }),
  outputSchema: z.object({ decision: z.string() }),
  execute: async ({ inputData, resumeData, suspend, suspendData }) => {
    if (!resumeData?.approved) {
      return suspend({ reason: 'user approval required', requestId: inputData.requestId });
    }
    return { decision: `${suspendData?.requestId ?? inputData.requestId}:approved` };
  },
  });

  const approvalWorkflow = createWorkflow({
    id: 'postgres-restart-approval',
    inputSchema: z.object({ requestId: z.string() }),
    outputSchema: z.object({ decision: z.string() }),
  }).then(approvalStep).commit();
  return { approvalStep, approvalWorkflow };
}

export async function recallOwnedThread(
  memory: Memory,
  threadId: string,
  resourceId: string,
) {
  const thread = await memory.getThreadById({ threadId });
  if (!thread || thread.resourceId !== resourceId) {
    throw new Error(`resource ${resourceId} does not own thread ${threadId}`);
  }
  return memory.recall({ threadId, resourceId, perPage: false });
}

export function createApp(connectionString: string) {
  const storage = new PostgresStore({
    id: 'mastra-proof-postgres',
    connectionString,
  });
  const memory = new Memory({ storage });
  const { approvalStep, approvalWorkflow } = createApprovalWorkflow();
  const mastra = new Mastra({ storage, workflows: { approvalWorkflow } });
  return { storage, memory, mastra, approvalStep };
}
