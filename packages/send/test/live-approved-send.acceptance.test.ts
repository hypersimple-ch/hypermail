import { describe, expect, it } from 'vitest';
import { PrivateApprovedSendHttpProvider } from '../src/index.js';

const enabled = process.env['APPROVED_SEND_LIVE_ACCEPTANCE'] === '1';

describe.skipIf(!enabled)('live approved-send acceptance', () => {
  it('deduplicates one explicitly authorized test send at the private endpoint', async () => {
    const endpoint = process.env['APPROVED_SEND_ENDPOINT'];
    const authorization = process.env['APPROVED_SEND_TOKEN'];
    const accountId = process.env['APPROVED_SEND_ACCOUNT_ID'];
    const recipient = process.env['APPROVED_SEND_TEST_RECIPIENT'];
    const runId = process.env['APPROVED_SEND_ACCEPTANCE_RUN_ID'];
    if (!endpoint || !authorization || !accountId || !recipient || !runId) throw new Error('Complete approved-send live acceptance configuration is required');
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(runId)) throw new Error('APPROVED_SEND_ACCEPTANCE_RUN_ID must be an opaque 8-64 character value');

    const provider = new PrivateApprovedSendHttpProvider({ endpoint, authorization });
    const approved = {
      approvalId: `acceptance-${runId}`,
      accountId,
      draftId: `acceptance-${runId}`,
      draftVersion: 1,
      idempotencyKey: `acceptance-send:${runId}`,
      recipients: [{ kind: 'to' as const, address: recipient }],
      subject: `Hypermail release acceptance ${runId}`,
      body: 'Explicitly authorized Hypermail approved-send acceptance message.',
    };
    const first = await provider.send(approved);
    const replay = await provider.send(approved);
    expect(first.providerMessageId).toBeTruthy();
    expect(replay.providerMessageId).toBe(first.providerMessageId);
  });
});
