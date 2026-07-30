/**
 * The only provider-I/O boundary. This package deliberately has no dependency on
 * agent or policy packages; callers must supply a user-approved immutable payload.
 */
export type ApprovedSend = Readonly<{
  approvalId: string;
  accountId: string;
  draftId: string;
  draftVersion: number;
  idempotencyKey: string;
  recipients: readonly Readonly<{ kind: 'to' | 'cc' | 'bcc'; address: string }>[];
  subject: string;
  body: string;
}>;

export type ProviderSendResult = Readonly<{ providerMessageId: string }>;
export interface MailSendProvider { send(message: ApprovedSend): Promise<ProviderSendResult>; }

export class PrivateApprovedSendError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'PrivateApprovedSendError'; }
}

export type PrivateApprovedSendHttpOptions = Readonly<{
  /** Deployment-owned, private endpoint; it must durably deduplicate `idempotencyKey`. */
  endpoint: string;
  authorization: string;
  fetch?: typeof fetch;
}>;

type TrustedSendPayload = Readonly<{
  approvalId: string;
  accountId: string;
  draftId: string;
  draftVersion: number;
  idempotencyKey: string;
  message: Readonly<{ to: readonly string[]; cc: readonly string[]; bcc: readonly string[]; subject: string; body: string }>;
}>;

const mapPayload = (approved: ApprovedSend): TrustedSendPayload => ({
  approvalId: approved.approvalId,
  accountId: approved.accountId,
  draftId: approved.draftId,
  draftVersion: approved.draftVersion,
  idempotencyKey: approved.idempotencyKey,
  message: {
    to: approved.recipients.filter((recipient) => recipient.kind === 'to').map((recipient) => recipient.address),
    cc: approved.recipients.filter((recipient) => recipient.kind === 'cc').map((recipient) => recipient.address),
    bcc: approved.recipients.filter((recipient) => recipient.kind === 'bcc').map((recipient) => recipient.address),
    subject: approved.subject,
    body: approved.body,
  },
});

/**
 * Adapter for a deployment-owned trusted send endpoint: POST JSON, `Authorization`,
 * and `Idempotency-Key`; a successful response is exactly `{ providerMessageId: string }`.
 * Hypermail v0.7 has no native idempotent send contract, so deployment must provide
 * this private durable endpoint. Direct MCP transport never guarantees exactly-once.
 */
export class PrivateApprovedSendHttpProvider implements MailSendProvider {
  private readonly request: typeof fetch;
  constructor(private readonly options: PrivateApprovedSendHttpOptions) {
    if (!options.endpoint.startsWith('https://')) throw new RangeError('A private HTTPS send endpoint is required.');
    if (!options.authorization.trim()) throw new RangeError('Trusted send authorization is required.');
    this.request = options.fetch ?? fetch;
  }

  async send(approved: ApprovedSend): Promise<ProviderSendResult> {
    const payload = mapPayload(approved);
    if (!payload.approvalId || !payload.accountId || !payload.draftId || !payload.idempotencyKey || !Number.isSafeInteger(payload.draftVersion) || payload.draftVersion < 1 || payload.message.to.length === 0) throw new PrivateApprovedSendError('Malformed approved send payload.');
    let response: Response;
    try {
      response = await this.request(this.options.endpoint, { method: 'POST', headers: { authorization: this.options.authorization, 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': payload.idempotencyKey }, body: JSON.stringify(payload) });
    } catch (error) {
      throw new PrivateApprovedSendError(`Trusted send request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status !== 200) throw new PrivateApprovedSendError(`Trusted send endpoint returned HTTP ${String(response.status)}.`, response.status);
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new PrivateApprovedSendError('Trusted send endpoint returned a non-JSON response.', response.status);
    let result: unknown;
    try { result = await response.json(); } catch { throw new PrivateApprovedSendError('Trusted send endpoint returned malformed JSON.', response.status); }
    if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1 || typeof (result as Record<string, unknown>)['providerMessageId'] !== 'string' || !(result as Record<string, unknown>)['providerMessageId']) throw new PrivateApprovedSendError('Trusted send endpoint returned a malformed result.', response.status);
    return { providerMessageId: (result as Record<string, unknown>)['providerMessageId'] as string };
  }
}
