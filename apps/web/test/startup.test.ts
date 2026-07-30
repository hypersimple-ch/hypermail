import { access, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startWebServiceFromEnvironment } from '../src/index.js';

const validEnvironment = { DATABASE_URL: 'postgresql://localhost/hypermail', APP_ORIGIN: 'https://mail.example.test', AUTH_SECRET: 'a'.repeat(32), RECOVERY_RECIPIENT: 'owner@example.test', HYPERMAIL_URL: 'https://hypermail.internal/mcp', HYPERMAIL_KEY: 'b'.repeat(16), HYPERMAIL_PROTOCOL_VERSION: 'deployment-negotiated', VAPID_SUBJECT: 'mailto:owner@example.test', VAPID_PUBLIC_KEY: 'c'.repeat(16), VAPID_PRIVATE_KEY: 'd'.repeat(16), PUSH_SUBSCRIPTION_ENCRYPTION_KEY: 'e'.repeat(32) };

describe('web process startup', () => {
  it('removes owned attachment orphans before opening the listener', async () => {
    const directory = await mkdtemp(join('/var/tmp', 'hypermail-web-startup-'));
    const orphan = join(directory, 'hypermail-attachment-orphan');
    await writeFile(orphan, 'temporary');
    const old = new Date(Date.now() - 120_000);
    await utimes(orphan, old, old);

    const server = await startWebServiceFromEnvironment({ ...validEnvironment,
      ATTACHMENT_TEMP_DIRECTORY: directory,
      ATTACHMENT_ORPHAN_MAX_AGE_SECONDS: '60',
      PORT: '0',
    });
    try {
      await expect(access(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve(); }));
    }
  });

  it('fails closed when its production database or HTTPS origin is absent', async () => {
    await expect(startWebServiceFromEnvironment({ ATTACHMENT_TEMP_DIRECTORY: tmpdir(), PORT: '0' })).rejects.toThrow('DATABASE_URL');
    await expect(startWebServiceFromEnvironment({ ...validEnvironment, ATTACHMENT_TEMP_DIRECTORY: tmpdir(), APP_ORIGIN: 'http://mail.example.test', PORT: '0' })).rejects.toThrow('APP_ORIGIN');
  });
});
