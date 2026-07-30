import { bootstrapFromEnvironment } from './runtime.js';

// This is the sole side-effect entrypoint. Library consumers import ./index.js instead.
void bootstrapFromEnvironment().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Worker bootstrap failed'}\n`);
  process.exitCode = 1;
});
