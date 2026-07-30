import { cleanupAttachmentOrphans } from '@hypermail/hypermail';

export type AttachmentStartupOptions = Readonly<{ tempDirectory: string; minimumAgeMs: number }>;

export function attachmentStartupOptionsFromEnvironment(environment: NodeJS.ProcessEnv): AttachmentStartupOptions {
  const tempDirectory = environment['ATTACHMENT_TEMP_DIRECTORY'];
  if (!tempDirectory) throw new Error('ATTACHMENT_TEMP_DIRECTORY is required');
  const secondsText = environment['ATTACHMENT_ORPHAN_MAX_AGE_SECONDS'] ?? '3600';
  const seconds = Number(secondsText);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error('ATTACHMENT_ORPHAN_MAX_AGE_SECONDS must be a positive integer');
  return { tempDirectory, minimumAgeMs: seconds * 1_000 };
}

/** Invoke once during process startup (and therefore after every restart) before accepting attachment requests. */
export async function initializeAttachmentDelivery(options: AttachmentStartupOptions): Promise<void> {
  await cleanupAttachmentOrphans(options);
}
