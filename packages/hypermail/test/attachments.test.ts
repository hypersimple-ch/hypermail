import { access, chmod, mkdtemp, readFile, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AttachmentStream, cleanupAttachmentOrphans, contentDisposition } from '../src/index.js';

const metadata = { id: 'attachment', name: 'report.txt' };

describe('attachment temporary-file safety', () => {
  it('rejects symlink escapes, caps actual bytes, and makes cleanup idempotent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hypermail-attachment-test-'));
    const outside = join(tmpdir(), `hypermail-outside-${String(Date.now())}`); await writeFile(outside, 'outside');
    const link = join(directory, 'link'); await symlink(outside, link);
    await expect(AttachmentStream.open(metadata, link, { maxBytes: 10, tempDirectory: directory })).rejects.toThrow('outside');
    await expect(access(outside)).resolves.toBeUndefined();
    const path = join(directory, 'actual'); await writeFile(path, '123456');
    const attachment = await AttachmentStream.open(metadata, path, { maxBytes: 5, tempDirectory: directory });
    attachment.stream.resume(); await expect(once(attachment.stream, 'error')).resolves.toBeTruthy();
    const first = attachment.cleanup(); expect(attachment.cleanup()).toBe(first); await first;
    await expect(access(path)).rejects.toThrow();
  });

  it('does not unlink a replacement for the opened file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hypermail-attachment-identity-'));
    const path = join(directory, 'actual'); await writeFile(path, 'original');
    const attachment = await AttachmentStream.open(metadata, path, { maxBytes: 10, tempDirectory: directory });
    await unlink(path); await writeFile(path, 'replacement');
    attachment.stream.once('error', () => undefined); const closed = once(attachment.stream, 'close'); attachment.stream.destroy(); await closed;
    await attachment.cleanup();
    await expect(readFile(path, 'utf8')).resolves.toBe('replacement');
  });

  it('requires a dedicated, secure, non-symlink source root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hypermail-attachment-root-'));
    const path = join(directory, 'actual'); await writeFile(path, 'ok');
    await expect(AttachmentStream.open(metadata, path, { maxBytes: 10, tempDirectory: tmpdir() })).rejects.toThrow('temporary directory');
    const link = join(tmpdir(), `hypermail-attachment-root-link-${String(Date.now())}`); await symlink(directory, link);
    await expect(AttachmentStream.open(metadata, path, { maxBytes: 10, tempDirectory: link })).rejects.toThrow('non-symlink');
    const file = join(directory, 'not-a-directory'); await writeFile(file, 'x');
    await expect(AttachmentStream.open(metadata, path, { maxBytes: 10, tempDirectory: file })).rejects.toThrow('non-symlink');
    await chmod(directory, 0o770);
    await expect(AttachmentStream.open(metadata, path, { maxBytes: 10, tempDirectory: directory })).rejects.toThrow('group- or other-writable');
  });

  it('uses header-safe RFC 5987 filenames', () => {
    const value = contentDisposition('folder/evil\r\nX-Injected: yes".txt');
    expect(value).not.toMatch(/[\r\n]/); expect(value).toContain('filename*=UTF-8');
  });

  it('cleans only bounded, aged regular Hypermail-owned files from a private dedicated directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hypermail-attachments-'));
    const oldOwned = join(directory, 'hypermail-attachment-old'); const oldOwnedTwo = join(directory, 'hypermail-attachment-old-two'); const freshOwned = join(directory, 'hypermail-attachment-fresh'); const unrelated = join(directory, 'other.tmp');
    await Promise.all([writeFile(oldOwned, 'x'), writeFile(oldOwnedTwo, 'x'), writeFile(freshOwned, 'x'), writeFile(unrelated, 'x')]);
    const now = new Date('2026-04-01T00:00:00.000Z'); const old = new Date(now.valueOf() - 60_000);
    await Promise.all([utimes(oldOwned, old, old), utimes(oldOwnedTwo, old, old), utimes(freshOwned, new Date(now.valueOf() + 1), new Date(now.valueOf() + 1))]);
    await expect(cleanupAttachmentOrphans({ tempDirectory: directory, minimumAgeMs: 60_000, maxFiles: 1, now: () => now })).resolves.toBe(1);
    expect((await Promise.all([access(oldOwned).then(() => true, () => false), access(oldOwnedTwo).then(() => true, () => false)])).filter(Boolean)).toHaveLength(1);
    await expect(access(freshOwned)).resolves.toBeUndefined(); await expect(access(unrelated)).resolves.toBeUndefined();
    await expect(cleanupAttachmentOrphans({ tempDirectory: directory, minimumAgeMs: 60_000, now: () => now })).resolves.toBe(1);
    await expect(cleanupAttachmentOrphans({ tempDirectory: directory, minimumAgeMs: 60_000, now: () => now })).resolves.toBe(0);
    await expect(cleanupAttachmentOrphans({ tempDirectory: tmpdir(), minimumAgeMs: 0 })).rejects.toThrow('dedicated');
  });
});
