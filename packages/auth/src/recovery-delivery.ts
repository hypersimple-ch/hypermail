import { createHash, randomUUID } from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Sql } from 'postgres';

export interface RecoveryPayloadCodec { encrypt(value: string): Promise<string>; decrypt(value: string): Promise<string>; }
export type RecoverySmtpConfig = Readonly<{ host: string; port: number; secure: boolean; user?: string; password?: string; from: string; localDevelopment?: boolean }>;

/** Web-only transport. No SMTP credentials or raw recovery link cross into the worker. */
export class SmtpRecoveryDelivery {
  private readonly transport: Transporter;
  constructor(config: RecoverySmtpConfig) {
    if (!config.localDevelopment && !((config.secure && config.port === 465) || (!config.secure && config.port === 587))) throw new Error('Recovery SMTP requires validated TLS on 465 or STARTTLS on 587');
    this.transport = nodemailer.createTransport({ host: config.host, port: config.port, secure: config.secure, requireTLS: !config.localDevelopment && !config.secure, tls: { rejectUnauthorized: true }, ...(config.user ? { auth: { user: config.user, pass: config.password } } : {}), connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000 });
    this.from = config.from;
  }
  private readonly from: string;
  async deliver(input: Readonly<{ to: string; resetUrl: string; messageId: string }>): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: input.to, messageId: input.messageId, subject: 'Reset your Hypermail password', text: `A Hypermail password reset was requested. This single-use link expires after 15 minutes.\n\n${input.resetUrl}\n\nIf you did not request this, ignore this message.` });
  }
  async ready(): Promise<boolean> { try { await this.transport.verify(); return true; } catch { return false; } }
  close(): void { this.transport.close(); }
}

export async function purgeExpiredRecoveryPayloads(sql: Sql): Promise<void> {
  await sql`update app.recovery_mail_deliveries set state='failed',encrypted_payload=null,nonce=null,claim_expires_at=null,updated_at=now() where state in ('pending','processing','failed') and expires_at<=now() and encrypted_payload is not null`;
}
type Delivery = { id: string; recipient: string; encrypted_payload: string; provider_message_id: string; attempt: number };
/** Short web scheduler with bounded SMTP calls and token-fenced completion. */
export class RecoveryDeliveryScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private state: 'idle' | 'running' | 'stopped' = 'idle';
  constructor(private readonly sql: Sql, private readonly codec: RecoveryPayloadCodec, private readonly smtp: SmtpRecoveryDelivery) {}
  start(): void { if (this.state === 'running') return; this.state = 'running'; this.tick(); }
  async stop(): Promise<void> { this.state = 'stopped'; clearTimeout(this.timer); await this.running; this.smtp.close(); }
  private tick(): void {
    this.running = this.recover().catch(() => { /* No exception details: provider errors can contain the recovery link. Durable state retries. */ }).finally(() => { this.running = undefined; if (this.state === 'running') this.timer = setTimeout(() => { this.tick(); }, 1000); });
  }
  async recover(): Promise<void> {
    await purgeExpiredRecoveryPayloads(this.sql);
    // An expired final claim must become terminal, never create attempt four.
    await this.sql`update app.recovery_mail_deliveries set state='failed',encrypted_payload=null,nonce=null,claim_expires_at=null,updated_at=now() where state='processing' and attempt=3 and claim_expires_at<=now()`;
    for (let count = 0; count < 10 && this.state !== 'stopped'; count++) {
      const token = randomUUID();
      const rows = await this.sql<Delivery[]>`update app.recovery_mail_deliveries set state='processing',attempt=attempt+1,claim_token=${token},claim_expires_at=now()+interval '120 seconds',updated_at=now() where id=(select id from app.recovery_mail_deliveries where expires_at>now() and attempt<3 and ((state='pending' and next_attempt_at<=now()) or (state='processing' and claim_expires_at<=now())) order by next_attempt_at,id for update skip locked limit 1) returning id,recipient,encrypted_payload,provider_message_id,attempt`;
      const row = rows[0]; if (!row) return;
      let delivered = false;
      try { await this.smtp.deliver({ to: row.recipient, resetUrl: await this.codec.decrypt(row.encrypted_payload), messageId: row.provider_message_id }); delivered = true; } catch { /* Generic durable outcome only; never log SMTP/body/token. */ }
      const terminal = delivered || row.attempt >= 3;
      const delay = row.attempt === 1 ? 5000 : 30000;
      await this.sql`update app.recovery_mail_deliveries set state=${delivered ? 'delivered' : terminal ? 'failed' : 'pending'},encrypted_payload=case when ${terminal} then null else encrypted_payload end,nonce=case when ${terminal} then null else nonce end,claim_expires_at=null,next_attempt_at=now()+${delay}*interval '1 millisecond',updated_at=now() where id=${row.id} and state='processing' and claim_token=${token} and claim_expires_at>now()`;
    }
  }
}

/** Exact durable identity, including expired/used tokens; sender names alone never exclude mail. */
export class RecoveryMailIdentity {
  constructor(private readonly sql: Sql | { query(text: string, parameters: string[]): Promise<{ rows: readonly unknown[] }> }, private readonly appOrigin?: string) {}
  private async matches(text: string, parameters: string[]): Promise<boolean> {
    return typeof this.sql === 'function' ? (await this.sql.unsafe(text, parameters)).length > 0 : (await this.sql.query(text, parameters)).rows.length > 0;
  }
  async isRecoveryMail(input: Readonly<{ userId: string; internetMessageId?: string | null; body: string }>): Promise<boolean> {
    if (input.internetMessageId) {
      if (await this.matches('select 1 from app.recovery_mail_identifiers where owner_id=$1::uuid and provider_message_id=$2 limit 1', [input.userId, input.internetMessageId.trim()])) return true;
    }
    const urls = input.body.match(/https?:\/\/[^\s<>"']+/g) ?? [];
    const candidates: { origin: string; hash: string }[] = [];
    for (const candidate of urls) {
      let url: URL; try { url = new URL(candidate.replaceAll('&amp;', '&')); } catch { continue; }
      if (url.pathname !== '/auth/recovery/confirm' || (this.appOrigin !== undefined && url.origin !== new URL(this.appOrigin).origin)) continue;
      const token = new URLSearchParams(url.hash.slice(1)).get('token');
      if (!token || !/^[A-Za-z0-9_-]{20,200}$/.test(token)) continue;
      candidates.push({ origin: url.origin, hash: createHash('sha256').update(token).digest('base64url') });
    }
    if (candidates.length) {
      if (await this.matches('select 1 from app.recovery_mail_identifiers i join jsonb_to_recordset($2::text::jsonb) as candidate(origin text,hash text) on candidate.origin=i.canonical_origin and candidate.hash=i.token_hash where i.owner_id=$1::uuid limit 1', [input.userId, JSON.stringify(candidates)])) return true;
    }
    return false;
  }
}
