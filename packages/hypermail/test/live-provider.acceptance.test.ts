import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { HypermailReadClient } from '../src/index.js';

type ProviderName = 'outlook' | 'gmail' | 'imap';
type MutationCase = Readonly<{ provider: ProviderName; name: string; arguments: Record<string, string | number | boolean | readonly Record<string, string>[]> }>; 

const liveEnabled = process.env['HYPERMAIL_LIVE_ACCEPTANCE'] === '1';
const mutationEnabled = process.env['HYPERMAIL_LIVE_MUTATION_ACCEPTANCE'] === '1';
const endpoint = process.env['HYPERMAIL_URL'] ?? '';
const protocolVersion = process.env['HYPERMAIL_PROTOCOL_VERSION'] ?? '';
const authorization = process.env['HYPERMAIL_KEY'] ?? '';
const accountEnvironment: Record<ProviderName, string> = {
  outlook: 'HYPERMAIL_ACCEPTANCE_OUTLOOK_ACCOUNT',
  gmail: 'HYPERMAIL_ACCEPTANCE_GMAIL_ACCOUNT',
  imap: 'HYPERMAIL_ACCEPTANCE_IMAP_ACCOUNT',
};
const mutationAllowlist = new Set(['draft_email', 'edit_draft', 'move_email', 'archive_email', 'trash_email', 'mark_read', 'mark_unread']);

function configuredClient(): HypermailReadClient {
  if (!endpoint || !protocolVersion || !authorization) throw new Error('Live Hypermail endpoint, protocol version, and authorization are required');
  if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) throw new Error('HYPERMAIL_URL must be HTTP(S)');
  return new HypermailReadClient({ endpoint, protocolVersion, headers: { authorization: `Bearer ${authorization}` }, maxRetries: 1 });
}

function accountFor(provider: ProviderName): string {
  const account = process.env[accountEnvironment[provider]];
  if (!account) throw new Error(`${accountEnvironment[provider]} is required`);
  return account;
}

describe.skipIf(!liveEnabled)('live Hypermail provider read acceptance', () => {
  it.each(['outlook', 'gmail', 'imap'] as const)('%s completes onboarding projection and read surfaces', async (provider) => {
    const client = configuredClient();
    await client.initialize();
    const account = accountFor(provider);
    const projection = (await client.accounts(true)).find((candidate) => candidate.email === account);
    expect(projection?.provider).toBe(provider);
    expect((await client.folders(account)).length).toBeGreaterThan(0);
    const page = await client.inbox({ account, limit: 10 });
    expect(page.messages.every((message) => message.account === account)).toBe(true);
    const first = page.messages[0];
    if (first) {
      expect((await client.readMessage(account, first.id)).id).toBe(first.id);
      const criterion = first.subject?.trim();
      if (criterion) expect((await client.search({ query: criterion, limit: 10 })).some((message) => message.account === account)).toBe(true);
    }
  });

  it('publishes every required provider tool without exposing permanent deletion', async () => {
    const client = configuredClient();
    await client.initialize();
    const result = await client.transport.listTools();
    const tools = (result as { tools?: readonly { name?: string }[] }).tools ?? [];
    const names = new Set(tools.map((tool) => tool.name));
    for (const name of ['list_accounts', 'list_folders', 'list_emails', 'search_emails', 'read_email', 'read_attachment', 'get_new_emails', 'draft_email', 'edit_draft', 'move_email', 'archive_email', 'trash_email', 'mark_read', 'mark_unread']) expect(names.has(name)).toBe(true);
    expect(names.has('permanently_delete_email')).toBe(false);
  });
});

describe.skipIf(!liveEnabled || !mutationEnabled)('live Hypermail reversible mutation acceptance', () => {
  it('executes only explicitly allowlisted operator-supplied cases', async () => {
    const path = process.env['HYPERMAIL_LIVE_MUTATION_CASES_FILE'];
    if (!path) throw new Error('HYPERMAIL_LIVE_MUTATION_CASES_FILE is required');
    const cases = JSON.parse(await readFile(path, 'utf8')) as readonly MutationCase[];
    expect(cases.length).toBeGreaterThan(0);
    const client = configuredClient();
    await client.initialize();
    for (const testCase of cases) {
      expect(mutationAllowlist.has(testCase.name)).toBe(true);
      expect(testCase.arguments['account']).toBe(accountFor(testCase.provider));
      await expect(client.transport.call(testCase.name, testCase.arguments)).resolves.toBeDefined();
    }
  });
});
