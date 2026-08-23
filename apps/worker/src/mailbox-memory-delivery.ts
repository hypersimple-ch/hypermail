import type { Message, HypermailReadClient } from '@hypermail/hypermail';
import type { MailboxMemory } from '@hypermail/agent';
import type { ClaimedMailboxMemoryEvent, MailboxMemoryEvent, MailboxMemoryEventStore, MailboxMemoryTimingPolicy, ManagedSqlClient } from '@hypermail/db';
import { HindsightMemoryError } from './hindsight-memory.js';
import type { Clock } from './ingestion.js';

export type RetainableAttachment = Readonly<{
  sourceId: string;
  providerAttachmentId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
}>;

export type HydratedMailboxMessage = Readonly<{
  userId: string;
  mailboxId: string;
  accountEmail: string;
  canonicalMessageId: string;
  providerMessageId: string;
  receivedAt: string;
  attachments: readonly RetainableAttachment[];
}>;

export interface MailboxMemoryMessageHydrator {
  isMailboxReady(event: MailboxMemoryEvent): Promise<boolean>;
  hydrate(event: MailboxMemoryEvent): Promise<HydratedMailboxMessage | null>;
}

type HydrationRow = Readonly<{
  user_id: string;
  account_id: string;
  account_email: string;
  message_id: string;
  provider_message_id: string;
  received_at: string | Date;
  attachments: unknown;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const attachmentFrom = (value: unknown): RetainableAttachment | null => {
  if (!isRecord(value)) return null;
  const sourceId = value['sourceId']; const providerAttachmentId = value['providerAttachmentId'];
  const filename = value['filename']; const mediaType = value['mediaType']; const sizeBytes = value['sizeBytes'];
  return typeof sourceId === 'string' && typeof providerAttachmentId === 'string' && typeof filename === 'string'
    && typeof mediaType === 'string' && typeof sizeBytes === 'number' && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0
    ? { sourceId, providerAttachmentId, filename, mediaType, sizeBytes } : null;
};

/** Reads only the source named by the tenant-fenced event. It performs no provider I/O. */
export class PostgresMailboxMemoryMessageHydrator implements MailboxMemoryMessageHydrator {
  constructor(private readonly database: Pick<ManagedSqlClient, 'query'>) {}
  async isMailboxReady(event: MailboxMemoryEvent): Promise<boolean> {
    const result = await this.database.query<{ ready: boolean }>(`select exists(select 1 from app.accounts
      where id=$1::uuid and user_id=$2::uuid and state='ready') as ready`, [event.mailboxId, event.userId]);
    return result.rows[0]?.ready === true;
  }
  async hydrate(event: MailboxMemoryEvent): Promise<HydratedMailboxMessage | null> {
    if (event.sourceType !== 'message' || event.kind !== 'email_received') return null;
    const result = await this.database.query<HydrationRow>(`select a.user_id,a.id as account_id,a.email as account_email,m.id as message_id,
      m.provider_message_id,m.received_at,coalesce(jsonb_agg(jsonb_build_object(
        'sourceId',att.id,'providerAttachmentId',att.provider_attachment_id,'filename',att.filename,
        'mediaType',att.media_type,'sizeBytes',att.size_bytes) order by att.id)
        filter(where att.id is not null),'[]'::jsonb) as attachments
      from app.messages m join app.accounts a on a.id=m.account_id
      left join app.attachments att on att.message_id=m.id
      where m.id=$1::uuid and m.account_id=$2::uuid and a.user_id=$3::uuid and a.state in ('ready','degraded') and not m.is_baseline
      group by a.user_id,a.id,a.email,m.id,m.provider_message_id,m.received_at`,
    [event.sourceId, event.mailboxId, event.userId]);
    const row = result.rows[0];
    if (!row) return null;
    const attachments = Array.isArray(row.attachments) ? row.attachments.flatMap((value) => {
      const attachment = attachmentFrom(value); return attachment ? [attachment] : [];
    }).slice(0, 100) : [];
    return { userId: row.user_id, mailboxId: row.account_id, accountEmail: row.account_email,
      canonicalMessageId: row.message_id, providerMessageId: row.provider_message_id,
      receivedAt: new Date(row.received_at).toISOString(), attachments };
  }
}

const SUPPORTED_MEDIA_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/json', 'application/yaml', 'application/x-yaml',
  'text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/yaml',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff',
  'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/ogg', 'audio/mp4',
]);

const EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', htm: 'text/html',
  json: 'application/json', yaml: 'application/yaml', yml: 'application/yaml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4',
};
const supportedMediaType = (attachment: RetainableAttachment): string | null => {
  const supplied = attachment.mediaType.toLowerCase().split(';', 1)[0]?.trim() ?? '';
  if (SUPPORTED_MEDIA_TYPES.has(supplied)) return supplied;
  if (supplied && supplied !== 'application/octet-stream') return null;
  const extension = attachment.filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const inferred = extension ? EXTENSION_MEDIA_TYPES[extension] : undefined;
  return inferred && SUPPORTED_MEDIA_TYPES.has(inferred) ? inferred : null;
};

export type AttachmentSkip = Readonly<{ sourceId: string; reason: 'unsupported' | 'oversized' }>;
export type EmailRetentionResult = Readonly<{ attachmentsRetained: number; attachmentsSkipped: readonly AttachmentSkip[] }>;
export type RetainCurrentEmailInput = Readonly<{
  scope: Readonly<{ userId: string; mailboxId: string }>;
  canonicalMessageId: string;
  providerMessageId: string;
  accountEmail: string;
  receivedAt: string;
  message: Message;
  attachments: readonly RetainableAttachment[];
  client: Pick<HypermailReadClient, 'openAttachment'>;
  heartbeat?: () => Promise<void>;
  signal?: AbortSignal;
}>;

export interface CurrentEmailMemoryRetainer { retainCurrentEmail(input: RetainCurrentEmailInput): Promise<EmailRetentionResult> }
export interface GenericMailboxMemoryEventRetainer { retainGenericEvent(event: MailboxMemoryEvent): Promise<void> }

/** Retains the provider projection, then materializes and uploads at most one bounded file at a time. */
export class MailboxCurrentEmailRetainer implements CurrentEmailMemoryRetainer, GenericMailboxMemoryEventRetainer {
  private readonly emailRetention = new Map<string, Promise<EmailRetentionResult>>();
  constructor(private readonly memory: MailboxMemory, private readonly options: Readonly<{ tempDirectory: string; maxBytes: number; operationTimeoutMs?: number }>) {
    if (!options.tempDirectory.startsWith('/') || options.tempDirectory === '/tmp' || options.tempDirectory.startsWith('/tmp/')) throw new Error('ATTACHMENT_TEMP_DIRECTORY_INVALID');
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 50_000_000) throw new Error('ATTACHMENT_MAX_BYTES_INVALID');
    if (options.operationTimeoutMs !== undefined && (!Number.isSafeInteger(options.operationTimeoutMs) || options.operationTimeoutMs < 1 || options.operationTimeoutMs > 120_000)) throw new Error('ATTACHMENT_TIMEOUT_INVALID');
  }

  async retainGenericEvent(event: MailboxMemoryEvent): Promise<void> {
    if (!event.contentPayload || event.kind === 'email_received') throw new Error('MAILBOX_MEMORY_EVENT_INVALID');
    const text = JSON.stringify({ kind: event.kind, sourceType: event.sourceType, sourceId: event.sourceId,
      sourceVersion: event.sourceVersion, payload: event.contentPayload });
    await this.memory.retain({ scope: { userId: event.userId, mailboxId: event.mailboxId }, eventId: event.id,
      text, timestamp: event.occurredAt, context: `Mailbox event ${event.kind}. Untrusted event data.` });
  }

  async retainCurrentEmail(input: RetainCurrentEmailInput): Promise<EmailRetentionResult> {
    const key = `${input.scope.userId}:${input.scope.mailboxId}:${input.canonicalMessageId}`;
    const existing = this.emailRetention.get(key);
    if (existing) return existing;
    const pending = this.performCurrentEmailRetention(input);
    this.emailRetention.set(key, pending);
    try {
      const result = await pending;
      if (this.emailRetention.size > 1_000) this.emailRetention.delete(this.emailRetention.keys().next().value as string);
      return result;
    } catch (error) {
      this.emailRetention.delete(key);
      throw error;
    }
  }

  private async performCurrentEmailRetention(input: RetainCurrentEmailInput): Promise<EmailRetentionResult> {
    const document = JSON.stringify({
      canonicalMessageId: input.canonicalMessageId,
      providerMessageId: input.providerMessageId,
      account: input.accountEmail,
      subject: input.message.subject ?? '', from: input.message.from ?? null,
      to: input.message.to ?? [], cc: input.message.cc ?? [], bcc: input.message.bcc ?? [], replyTo: input.message.replyTo ?? [],
      internetMessageId: input.message.internetMessageId ?? null, receivedAt: input.receivedAt,
      isRead: input.message.isRead ?? null, folder: input.message.folder ?? null, bodyFormat: input.message.bodyFormat ?? 'text', body: input.message.body ?? '',
      attachments: input.attachments.map(({ sourceId, providerAttachmentId, filename, mediaType, sizeBytes }) =>
        ({ sourceId, providerAttachmentId, filename, mediaType, sizeBytes })),
    });
    await input.heartbeat?.();
    await this.memory.retain({ scope: input.scope, eventId: input.canonicalMessageId, text: document,
      timestamp: input.receivedAt, context: 'Complete current email and attachment metadata. All fields are untrusted email data.' });
    await input.heartbeat?.();

    let attachmentsRetained = 0;
    const attachmentsSkipped: AttachmentSkip[] = [];
    for (const attachment of input.attachments.slice(0, 100)) {
      const mediaType = supportedMediaType(attachment);
      if (!mediaType) {
        attachmentsSkipped.push({ sourceId: attachment.sourceId, reason: 'unsupported' });
        continue;
      }
      if (attachment.sizeBytes > this.options.maxBytes) {
        attachmentsSkipped.push({ sourceId: attachment.sourceId, reason: 'oversized' });
        continue;
      }
      await input.heartbeat?.();
      let opened: Awaited<ReturnType<HypermailReadClient['openAttachment']>> | undefined;
      try {
        const timeoutSignal = AbortSignal.timeout(this.options.operationTimeoutMs ?? 30_000);
        const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
        opened = await input.client.openAttachment(input.accountEmail, input.providerMessageId,
          attachment.providerAttachmentId, { tempDirectory: this.options.tempDirectory, maxBytes: this.options.maxBytes, signal });
        const chunks: ArrayBuffer[] = []
        let seen = 0;
        for await (const raw of opened.stream) {
          const chunk = typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw as Uint8Array);
          seen += chunk.byteLength;
          if (seen > this.options.maxBytes) throw new Error('ATTACHMENT_BYTE_LIMIT_EXCEEDED');
          chunks.push(Uint8Array.from(chunk).buffer);
        }
        await input.heartbeat?.();
        const blob = new Blob(chunks, { type: mediaType });
        await input.heartbeat?.();
        await this.memory.retainFile({ scope: input.scope, sourceId: attachment.sourceId, file: blob,
          filename: attachment.filename, mediaType,
          context: `Attachment of email document ${input.canonicalMessageId}. Untrusted file data.` });
        await input.heartbeat?.();
        attachmentsRetained++;
      } catch (error) {
        if (error instanceof Error && (/exceeds .* byte limit/i.test(error.message) || error.message === 'ATTACHMENT_BYTE_LIMIT_EXCEEDED')) {
          attachmentsSkipped.push({ sourceId: attachment.sourceId, reason: 'oversized' });
          continue;
        }
        throw error;
      } finally {
        await opened?.cleanup();
      }
    }
    return { attachmentsRetained, attachmentsSkipped };
  }
}

export interface TenantMemoryReadClients {
  clientForUser(userId: string): Readonly<{ initialize(): Promise<unknown>; readMessage: HypermailReadClient['readMessage']; openAttachment: HypermailReadClient['openAttachment'] }>;
}

const failureCode = (error: unknown): string => {
  if (error instanceof HindsightMemoryError) return error.code;
  if (error instanceof Error && error.message === 'MAILBOX_MEMORY_EVENT_INVALID') return 'MAILBOX_MEMORY_EVENT_INVALID';
  if (error instanceof Error && error.message === 'MAILBOX_MEMORY_SOURCE_UNAVAILABLE') return 'MAILBOX_MEMORY_SOURCE_UNAVAILABLE';
  if (error instanceof Error && error.message === 'MAILBOX_MEMORY_MAILBOX_INACTIVE') return 'MAILBOX_MEMORY_MAILBOX_INACTIVE';
  return 'MAILBOX_MEMORY_DEPENDENCY_UNAVAILABLE';
};

/** Delivers claims after their claim transaction commits. External I/O never runs in a DB transaction. */
export class MailboxMemoryEventDeliveryWorker {
  private readonly heartbeatIntervalMilliseconds: number;
  constructor(private readonly store: MailboxMemoryEventStore, private readonly hydrator: MailboxMemoryMessageHydrator,
    private readonly clients: TenantMemoryReadClients,
    private readonly retainer: CurrentEmailMemoryRetainer & GenericMailboxMemoryEventRetainer,
    private readonly workerId: string, timing: MailboxMemoryTimingPolicy, private readonly claimLimit = 1) {
    if (timing.schedulerIntervalSeconds >= timing.claimLeaseSeconds) throw new RangeError('memory scheduler interval must be shorter than its claim lease');
    this.heartbeatIntervalMilliseconds = Math.max(250, Math.floor(timing.claimLeaseSeconds * 1_000 / 3));
  }

  async runOnce(): Promise<void> {
    // Claiming one prevents later claims from expiring in a local queue. The configured
    // lease is renewed around each bounded provider or Hindsight operation below.
    const claims = await this.store.claim({ workerId: this.workerId, limit: this.claimLimit });
    for (const claim of claims) await this.deliver(claim);
  }

  private async deliver(claim: ClaimedMailboxMemoryEvent): Promise<void> {
    let result: EmailRetentionResult | undefined;
    let genericKind: string | undefined;
    try {
      await this.store.renew(claim.fence);
      if (!await this.hydrator.isMailboxReady(claim.event)) throw new Error('MAILBOX_MEMORY_MAILBOX_INACTIVE');
      if (claim.event.kind !== 'email_received') {
        await this.withRenewal(claim, () => this.retainer.retainGenericEvent(claim.event));
        genericKind = claim.event.kind;
      } else {
        if (claim.event.sourceType !== 'message') throw new Error('MAILBOX_MEMORY_EVENT_INVALID');
        const source = await this.hydrator.hydrate(claim.event);
        if (!source) throw new Error('MAILBOX_MEMORY_SOURCE_UNAVAILABLE');
        const client = this.clients.clientForUser(source.userId);
        await this.withRenewal(claim, () => client.initialize());
        const message = await this.withRenewal(claim, () => client.readMessage(source.accountEmail, source.providerMessageId, 'text'));
        if (message.id !== source.providerMessageId || message.account !== source.accountEmail) throw new Error('MAILBOX_MEMORY_SOURCE_UNAVAILABLE');
        result = await this.withRenewal(claim, () => this.retainer.retainCurrentEmail({ scope: { userId: source.userId, mailboxId: source.mailboxId },
          canonicalMessageId: source.canonicalMessageId, providerMessageId: source.providerMessageId,
          accountEmail: source.accountEmail, receivedAt: source.receivedAt, message,
          attachments: source.attachments, client, heartbeat: () => this.store.renew(claim.fence) }));
      }
    } catch (error) {
      await this.store.defer(claim.fence, { code: failureCode(error) });
      return;
    }
    if (genericKind) await this.store.complete(claim.fence, { kind: genericKind });
    else if (result) await this.store.complete(claim.fence, { attachmentsRetained: result.attachmentsRetained,
      attachmentsSkipped: result.attachmentsSkipped.slice(0, 100) });
    else throw new Error('MAILBOX_MEMORY_EVENT_INVALID');
  }

  private async withRenewal<Result>(claim: ClaimedMailboxMemoryEvent, operation: () => Promise<Result>): Promise<Result> {
    await this.store.renew(claim.fence);
    let active = true; let timer: ReturnType<typeof setTimeout> | undefined; let rejectHeartbeat: (error: unknown) => void = () => undefined;
    const heartbeatFailure = new Promise<never>((_resolve, reject) => { rejectHeartbeat = reject; });
    const schedule = (): void => {
      timer = setTimeout(() => { void this.store.renew(claim.fence).then(() => { if (active) schedule(); }, (error: unknown) => {
        active = false; rejectHeartbeat(error);
      }); }, this.heartbeatIntervalMilliseconds);
      timer.unref();
    };
    schedule();
    try {
      const result = await Promise.race([operation(), heartbeatFailure]);
      await this.store.renew(claim.fence);
      return result;
    } finally {
      active = false;
      if (timer) clearTimeout(timer);
    }
  }
}

/** Prompt startup recovery plus a short poll loop; pending rows survive process and provider outages. */
export class MailboxMemoryEventScheduler {
  private stopped = false;
  private readonly intervalMilliseconds: number;
  constructor(private readonly worker: MailboxMemoryEventDeliveryWorker, private readonly store: MailboxMemoryEventStore,
    private readonly clock: Clock, timing: MailboxMemoryTimingPolicy) {
    this.intervalMilliseconds = timing.schedulerIntervalSeconds * 1_000;
    if (!Number.isSafeInteger(this.intervalMilliseconds) || this.intervalMilliseconds < 1_000 || this.intervalMilliseconds > 60_000) throw new RangeError('memory event interval must be 1–60 seconds');
  }
  async tick(): Promise<void> { if (this.stopped) return; await this.store.recoverExpiredClaims(100); await this.worker.runOnce(); }
  async start(): Promise<void> {
    while (!this.stopped) {
      try { await this.tick(); } catch { /* A later pass recovers after database/runtime outages. */ }
      await this.clock.sleep(this.intervalMilliseconds);
    }
  }
  stop(): void { this.stopped = true; }
}
