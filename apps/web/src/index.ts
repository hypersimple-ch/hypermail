import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { attachmentStartupOptionsFromEnvironment, initializeAttachmentDelivery } from './attachments/startup.js';
import { createWebRuntimeFromEnvironment, type WebRuntime } from './runtime.js';
import { startWebServer } from './server.js';

export const webService = { name: 'hypermail-web', exposure: 'public-https' } as const;
export * from './ui/index.js';
export * from './attachments/index.js';
export * from './pwa/index.js';
export { createWebServer, startWebServer } from './server.js';
export { createWebRuntimeFromEnvironment, type WebRuntime } from './runtime.js';

/** Validates production configuration and completes cleanup before accepting HTTP requests. */
export async function startWebServiceFromEnvironment(environment: NodeJS.ProcessEnv = process.env, runtime?: WebRuntime) {
  // Validate authoritative runtime settings before touching temporary storage or opening a listener.
  const composed = runtime ?? createWebRuntimeFromEnvironment(environment);
  try {
    await initializeAttachmentDelivery(attachmentStartupOptionsFromEnvironment(environment));
    const port = environment['PORT'] === undefined ? 3000 : Number(environment['PORT']);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('PORT must be an integer between 0 and 65535');
    return startWebServer(port, composed);
  } catch (error) {
    await composed.close();
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void startWebServiceFromEnvironment().catch(() => { process.stderr.write('Hypermail web startup failed\n'); process.exitCode = 1; });
}
