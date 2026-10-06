import { access, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startWebServiceFromEnvironment } from '../src/index.js';
import { spawn } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';

const validEnvironment = { DATABASE_URL: 'postgresql://synthetic:synthetic-only@127.0.0.1:1/hypermail-startup-fixture', APP_ORIGIN: 'https://mail.example.test', AUTH_SECRET: 'a'.repeat(32), OAUTH_TOKEN_HASH_KEY: 'o'.repeat(32), HYPERMAIL_URL: 'https://hypermail.internal/mcp', HYPERMAIL_KEY: 'b'.repeat(16), HYPERMAIL_PROTOCOL_VERSION: 'deployment-negotiated', VAPID_SUBJECT: 'mailto:owner@example.test', VAPID_PUBLIC_KEY: 'c'.repeat(16), VAPID_PRIVATE_KEY: 'd'.repeat(16), PUSH_SUBSCRIPTION_ENCRYPTION_KEY: 'e'.repeat(32) };

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
    await expect(startWebServiceFromEnvironment({ ...validEnvironment, ATTACHMENT_TEMP_DIRECTORY: '/var/tmp', APP_ORIGIN: 'http://mail.example.test', PORT: '0' })).rejects.toThrow('APP_ORIGIN');
  });
});
describe('web CLI shutdown', () => {
  it('exits cleanly and closes database sockets when PostgreSQL stops answering after startup', async () => {
    const directory = await mkdtemp('/var/tmp/hypermail-cli-shutdown-');
    const sockets = new Set<Socket>();
    const queried = Promise.withResolvers<undefined>();
    // Owned loopback black hole: no query can reach a real database or user data.
    const database = createServer(socket => {
      sockets.add(socket);
      socket.resume();
      socket.once('close', () => { sockets.delete(socket); });
      socket.once('data', () => {
        // PostgreSQL AuthenticationOk + ReadyForQuery; subsequent queries stay blocked.
        socket.write(Buffer.from('5200000008000000005a0000000549', 'hex'));
        socket.on('data', (packet: Buffer) => { if (packet[0] === 0x51 || packet[0] === 0x50) queried.resolve(undefined); });
      });
    });
    const reservation = createServer();
    await new Promise<void>(resolve => { database.listen(0, '127.0.0.1', resolve); });
    await new Promise<void>(resolve => { reservation.listen(0, '127.0.0.1', resolve); });
    const databaseAddress = database.address(); const webAddress = reservation.address();
    if (!databaseAddress || typeof databaseAddress === 'string' || !webAddress || typeof webAddress === 'string') throw new Error('Missing owned TCP addresses');
    await new Promise<void>(resolve => { reservation.close(() => { resolve(); }); });
    const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/index.js', import.meta.url))], {
      stdio: 'ignore',
      env: {
        NODE_ENV: 'production', PORT: String(webAddress.port),
        DATABASE_URL: `postgresql://synthetic:synthetic-only@127.0.0.1:${String(databaseAddress.port)}/shutdown_test`,
        APP_ORIGIN: 'https://mail.example.test', AUTH_SECRET: 'a'.repeat(32), OAUTH_TOKEN_HASH_KEY: 'o'.repeat(32),
        HYPERMAIL_URL: `http://127.0.0.1:${String(databaseAddress.port)}/mcp`, HYPERMAIL_KEY: 'b'.repeat(32), HYPERMAIL_PROTOCOL_VERSION: '2024-11-05',
        VAPID_SUBJECT: 'mailto:owner@example.test', VAPID_PUBLIC_KEY: 'c'.repeat(32), VAPID_PRIVATE_KEY: 'd'.repeat(32),
        PUSH_SUBSCRIPTION_ENCRYPTION_KEY: 'e'.repeat(32), ATTACHMENT_TEMP_DIRECTORY: join(directory, 'attachments'),
      },
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('exit', (code, signal) => { resolve({ code, signal }); });
      child.once('error', () => { resolve({ code: -1, signal: null }); });
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const bootDeadline = Date.now() + 10_000;
      // Real clock: this child has its own event loop. Parent fake timers cannot drive
      // its TCP startup or the platform SIGTERM/45-second host shutdown deadline.
      for (;;) {
        try {
          const response = await fetch(`http://127.0.0.1:${String(webAddress.port)}/health/live`, { signal: AbortSignal.timeout(500) });
          if (response.ok && (await response.json() as { status?: unknown }).status === 'ok') break;
        } catch { /* The owned process has not opened its listener yet. */ }
        if (child.exitCode !== null || Date.now() >= bootDeadline) throw new Error('Owned web CLI did not become live');
        await new Promise(resolve => { setTimeout(resolve, 50); });
      }
      await queried.promise;
      child.kill('SIGTERM');
      const result = await Promise.race([exited, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => { reject(new Error('Web did not quiesce within the45-second host stop deadline')); }, 45_000);
      })]);
      expect(result).toEqual({ code: 0, signal: null });
      await new Promise<void>(resolve => { database.close(() => { resolve(); }); });
      expect(sockets.size).toBe(0);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      for (const socket of sockets) socket.destroy();
      if (database.listening) await new Promise<void>(resolve => { database.close(() => { resolve(); }); });
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
