import type { MailMessage, MailProvider } from './ingestion.js';

interface HypermailReadPort {
  establishBaseline(account?: string): Promise<void>;
  pollNewInbox(account?: string, limit?: number): Promise<MailMessage[]>;
  inbox(input: { account: string; limit: number }): Promise<{ messages: MailMessage[] }>;
}

/** Adapts the read-only Hypermail client; it intentionally exposes no mutation APIs. */
export class HypermailInboxProvider implements MailProvider {
  constructor(private readonly client: HypermailReadPort) {}
  establishBaseline(account: string): Promise<void> { return this.client.establishBaseline(account); }
  pollNewInbox(account: string, limit: number): Promise<MailMessage[]> { return this.client.pollNewInbox(account, limit); }
  async recentInbox(account: string, limit: number): Promise<MailMessage[]> { return (await this.client.inbox({ account, limit })).messages; }
}
