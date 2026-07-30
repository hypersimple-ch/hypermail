import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ScopedHypermailAttachmentReader } from '../../src/attachments/hypermail-reader.js';

const query = vi.fn(() => Promise.resolve({ rows: [{ email: 'owner@example.test', provider_message_id: 'provider-message', provider_attachment_id: 'provider-attachment' }] }));

describe('ScopedHypermailAttachmentReader', () => {
  it('maps scoped application UUIDs to provider identifiers before provider access', async () => {
    const initialize = vi.fn(() => Promise.resolve({}));
    const openAttachment = vi.fn(() => Promise.resolve({ metadata: { name: 'report.txt' }, contentDisposition: 'attachment; filename="report.txt"', stream: Readable.from(['ok']), cleanup: () => Promise.resolve() }));
    const reader = new ScopedHypermailAttachmentReader({ query } as never, { initialize, openAttachment } as never);
    await reader.openAttachment('app-account', 'app-message', 'app-attachment', { maxBytes: 10, tempDirectory: '/private' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('provider_attachment_id'), ['app-account', 'app-message', 'app-attachment']);
    expect(initialize).toHaveBeenCalledOnce();
    expect(openAttachment).toHaveBeenCalledWith('owner@example.test', 'provider-message', 'provider-attachment', { maxBytes: 10, tempDirectory: '/private' });
  });
});
