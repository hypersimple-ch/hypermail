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
  bodyFormat: 'markdown' | 'html';
}>;

/** A POST response is connector-reported only; it is never authoritative proof of delivery. */
export type ProviderSendResult = Readonly<{ providerMessageId: string }>;
export type ProviderSendStatus =
  | Readonly<{ state: 'verified'; providerMessageId: string; observedAt: string; evidence: Readonly<Record<string, unknown>> }>
  | Readonly<{ state: 'rejected'; reasonCode: string }>
  | Readonly<{ state: 'pending' | 'unknown' }>;
export interface MailSendProvider { send(message: ApprovedSend): Promise<ProviderSendResult>; status?(idempotencyKey: string): Promise<ProviderSendStatus>; }
export interface AuthoritativeMailSendProvider extends MailSendProvider { status(idempotencyKey: string): Promise<ProviderSendStatus>; }

export class PrivateApprovedSendError extends Error {
  constructor(message: string, readonly status?: number, readonly definiteRejection = false) { super(message); this.name = 'PrivateApprovedSendError'; }
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
  message: Readonly<{ to: readonly string[]; cc: readonly string[]; bcc: readonly string[]; subject: string; body: string; bodyFormat: 'markdown' | 'html' }>;
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
    bodyFormat: approved.bodyFormat,
  },
});

/**
 * Adapter for a deployment-owned trusted send endpoint: POST JSON, `Authorization`,
 * and `Idempotency-Key`; a successful response is exactly `{ providerMessageId: string }`.
 * Hypermail v0.7 has no native idempotent send contract, so deployment must provide
 * this private durable endpoint. Direct MCP transport never guarantees exactly-once.
 */
const boundedJson = async (response: Response): Promise<unknown> => {
  const limit = 64_000; const declared = Number(response.headers.get('content-length')); if (Number.isFinite(declared) && declared > limit) throw new PrivateApprovedSendError('Trusted send endpoint response is too large.', response.status);
  const stream = response.body;
  if (!stream) throw new PrivateApprovedSendError('Trusted send endpoint returned malformed JSON.', response.status);
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  let finished = false; while (!finished) { const part = await reader.read(); finished = part.done; if (!part.done) { size += part.value.byteLength; if (size > limit) { await reader.cancel(); throw new PrivateApprovedSendError('Trusted send endpoint response is too large.', response.status); } chunks.push(part.value); } }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  try { return JSON.parse(body) as unknown; } catch { throw new PrivateApprovedSendError('Trusted send endpoint returned malformed JSON.', response.status); }
};

export class PrivateApprovedSendHttpProvider implements MailSendProvider {
  private readonly request: typeof fetch;
  constructor(private readonly options: PrivateApprovedSendHttpOptions) {
    if (!options.endpoint.startsWith('https://')) throw new RangeError('A private HTTPS send endpoint is required.');
    if (!options.authorization.trim()) throw new RangeError('Trusted send authorization is required.');
    this.request = options.fetch ?? fetch;
  }

  async send(approved: ApprovedSend): Promise<ProviderSendResult> {
    const payload = mapPayload(approved);
    if (!payload.approvalId || !payload.accountId || !payload.draftId || !payload.idempotencyKey || !Number.isSafeInteger(payload.draftVersion) || payload.draftVersion < 1 || payload.message.to.length === 0 || !(['markdown', 'html'] as readonly unknown[]).includes(payload.message.bodyFormat)) throw new PrivateApprovedSendError('Malformed approved send payload.');
    let response: Response;
    try {
      response = await this.request(this.options.endpoint, { method: 'POST', headers: { authorization: this.options.authorization, 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': payload.idempotencyKey }, body: JSON.stringify(payload) });
    } catch (error) {
      throw new PrivateApprovedSendError(`Trusted send request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status !== 200) throw new PrivateApprovedSendError(`Trusted send endpoint returned HTTP ${String(response.status)}.`, response.status, response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status));
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new PrivateApprovedSendError('Trusted send endpoint returned a non-JSON response.', response.status);
    const result = await boundedJson(response);
    if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1 || typeof (result as Record<string, unknown>)['providerMessageId'] !== 'string' || !(result as Record<string, unknown>)['providerMessageId']) throw new PrivateApprovedSendError('Trusted send endpoint returned a malformed result.', response.status);
    return { providerMessageId: (result as Record<string, unknown>)['providerMessageId'] as string };
  }

  /** Read-only reconciliation. The trusted endpoint must derive `verified` from a Hypermail provider readback. */
  async status(idempotencyKey: string): Promise<ProviderSendStatus> {
    if (!idempotencyKey.trim()) throw new PrivateApprovedSendError('Malformed send status key.');
    let response: Response;
    try {
      const url = new URL(this.options.endpoint); url.pathname = `${url.pathname.replace(/\/$/, '')}/status`; url.search = '';
      response = await this.request(url, { method: 'GET', headers: { authorization: this.options.authorization, accept: 'application/json', 'idempotency-key': idempotencyKey } });
    } catch (error) { throw new PrivateApprovedSendError(`Trusted send status request failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (response.status !== 200) throw new PrivateApprovedSendError(`Trusted send status endpoint returned HTTP ${String(response.status)}.`, response.status);
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new PrivateApprovedSendError('Trusted send status endpoint returned a non-JSON response.', response.status);
    const value = await boundedJson(response);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PrivateApprovedSendError('Trusted send status endpoint returned a malformed result.', response.status);
    const record = value as Record<string, unknown>; const state = record['state'];
    if ((state === 'pending' || state === 'unknown') && Object.keys(record).length === 1) return { state };
    if (state === 'rejected' && Object.keys(record).length === 2 && typeof record['reasonCode'] === 'string' && record['reasonCode']) return { state, reasonCode: record['reasonCode'] };
    if (state === 'verified' && Object.keys(record).length === 4 && typeof record['providerMessageId'] === 'string' && record['providerMessageId'] && typeof record['observedAt'] === 'string' && Number.isFinite(Date.parse(record['observedAt'])) && record['evidence'] && typeof record['evidence'] === 'object' && !Array.isArray(record['evidence'])) return { state, providerMessageId: record['providerMessageId'], observedAt: record['observedAt'], evidence: record['evidence'] as Readonly<Record<string, unknown>> };
    throw new PrivateApprovedSendError('Trusted send status endpoint returned a malformed result.', response.status);
  }
}
