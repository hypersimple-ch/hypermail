import type { MailMessage, MailProvider } from './ingestion.js';

export interface HypermailReadPort {
  establishBaseline(account?: string): Promise<void>;
  pollNewInbox(account?: string, limit?: number): Promise<MailMessage[]>;
  inbox(input: { account: string; limit: number }): Promise<{ messages: MailMessage[] }>;
}

export interface TenantHypermailReadPort {
  clientForUser(userId: string): HypermailReadPort;
}

/** Adapts tenant-scoped read-only Hypermail clients; it exposes no mutation APIs. */
export class HypermailInboxProvider implements MailProvider {
  constructor(private readonly clients: TenantHypermailReadPort) {}
  establishBaseline(userId: string, account: string): Promise<void> { return this.clients.clientForUser(userId).establishBaseline(account); }
  pollNewInbox(userId: string, account: string, limit: number): Promise<MailMessage[]> { return this.clients.clientForUser(userId).pollNewInbox(account, limit); }
  async recentInbox(userId: string, account: string, limit: number): Promise<MailMessage[]> { return (await this.clients.clientForUser(userId).inbox({ account, limit })).messages; }
}
