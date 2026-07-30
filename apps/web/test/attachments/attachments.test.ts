import { readFileSync } from 'node:fs';
import { mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { AttachmentReader, DeliveredAttachment } from '../../src/attachments/contracts.js';
import { createAttachmentRoutes } from '../../src/attachments/routes.js';
import { AttachmentDeliveryService } from '../../src/attachments/service.js';
import { attachmentStartupOptionsFromEnvironment, initializeAttachmentDelivery } from '../../src/attachments/startup.js';

const scope = { subjectId: 'person-1', accountIds: ['account-1'] };
const attachment = (overrides: Partial<DeliveredAttachment> = {}): DeliveredAttachment => ({ metadata: { name: 'report.txt', contentType: 'text/plain' }, contentDisposition: 'attachment; filename="report.txt"', stream: Readable.from(['hello']), cleanup: () => Promise.resolve(), ...overrides });
const reader = (result: DeliveredAttachment | Error = attachment()) => ({ openAttachment: vi.fn(() => result instanceof Error ? Promise.reject(result) : Promise.resolve(result)) }) satisfies AttachmentReader;
const request = { method: 'GET', auth: scope, origin: 'https://mail.example', apiVersion: '6' };
const tempDirectory = '/private/hypermail-attachments';

describe('attachment delivery route', () => {
  it('requires same-origin authenticated versioned access and isolates accounts before opening', async () => {
    const source = reader(); const routes = createAttachmentRoutes(new AttachmentDeliveryService(source, { maxBytes: 10, tempDirectory }), { expectedOrigin: 'https://mail.example', apiVersion: '6' });
    expect((await routes.download({ ...request, auth: null }, 'account-1', 'm', 'a')).status).toBe(401);
    expect((await routes.download({ ...request, origin: 'https://evil.example' }, 'account-1', 'm', 'a')).status).toBe(403);
    expect((await routes.download({ ...request, apiVersion: '5' }, 'account-1', 'm', 'a')).status).toBe(426);
    expect((await routes.download(request, 'other-account', 'm', 'a')).status).toBe(404);
    expect(source.openAttachment).not.toHaveBeenCalled();
  });

  it('returns only safe download headers, falls back malformed MIME, and hides reader failures', async () => {
    const unsafe = attachment({ metadata: { name: 'x', contentType: 'text/plain\r\nX-Injected: yes' }, contentDisposition: 'attachment; filename="safe.txt"' });
    const routes = createAttachmentRoutes(new AttachmentDeliveryService(reader(unsafe), { maxBytes: 10, tempDirectory }), { expectedOrigin: 'https://mail.example', apiVersion: '6' });
    const response = await routes.download(request, 'account-1', 'm', 'a');
    expect(response).toMatchObject({ status: 200, headers: { 'content-type': 'application/octet-stream', 'x-content-type-options': 'nosniff' } });
    expect(response).not.toHaveProperty('body');
    expect(response.cleanup).toBeTypeOf('function'); await response.cleanup?.();
    const failed = createAttachmentRoutes(new AttachmentDeliveryService(reader(new Error('/private/path provider exploded')), { maxBytes: 10, tempDirectory }), { expectedOrigin: 'https://mail.example', apiVersion: '6' });
    const failure = await failed.download(request, 'account-1', 'm', 'a'); expect(failure).toEqual({ status: 502, headers: { 'cache-control': 'no-store' } });
  });

  it('requires explicit secure startup cleanup configuration', () => {
    expect(() => attachmentStartupOptionsFromEnvironment({})).toThrow(/ATTACHMENT_TEMP_DIRECTORY/);
    expect(() => attachmentStartupOptionsFromEnvironment({ ATTACHMENT_TEMP_DIRECTORY: '/secure', ATTACHMENT_ORPHAN_MAX_AGE_SECONDS: '0' })).toThrow(/positive integer/);
    expect(attachmentStartupOptionsFromEnvironment({ ATTACHMENT_TEMP_DIRECTORY: '/secure' })).toEqual({ tempDirectory: '/secure', minimumAgeMs: 3_600_000 });
  });

  it('passes cancellation to the bounded reader and runs restart cleanup', async () => {
    const source = reader(); const service = new AttachmentDeliveryService(source, { maxBytes: 10, tempDirectory }); const controller = new AbortController();
    await service.open(scope, { accountId: 'account-1', messageId: 'm', attachmentId: 'a' }, controller.signal);
    expect(source.openAttachment).toHaveBeenCalledWith('account-1', 'm', 'a', expect.objectContaining({ signal: controller.signal, maxBytes: 10, tempDirectory }));
    const directory = await mkdtemp(join(tmpdir(), 'hypermail-attachments-')); const old = join(directory, 'hypermail-attachment-restart'); await writeFile(old, 'x');
    const then = new Date(Date.now() - 120_000); await utimes(old, then, then); await initializeAttachmentDelivery({ tempDirectory: directory, minimumAgeMs: 60_000 });
    expect(() => readFileSync(old)).toThrow();
  });

  it('does not import agent or model code into the delivery boundary', () => {
    for (const file of ['contracts.ts', 'service.ts', 'routes.ts']) {
      const source = readFileSync(resolve(import.meta.dirname, `../../src/attachments/${file}`), 'utf8');
      expect(source).not.toMatch(/from ['"].*\/(agent|model)/);
    }
  });
});
