import { cp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import process from 'node:process';

const role = process.argv[2];
const planOnly = process.argv.includes('--plan');
const webProjects = [
  'packages/contracts', 'packages/agent-connections', 'packages/auth', 'packages/db',
  'packages/hypermail', 'packages/notifications', 'packages/observability', 'packages/send', 'apps/web',
];
const workerProjects = [
  'packages/contracts', 'packages/agent', 'packages/db', 'packages/hypermail',
  'packages/notifications', 'packages/policy', 'packages/observability', 'apps/worker',
];
const typeWatcher = (projects) => ['pnpm', ['exec', 'tsc', '-b', ...projects, '--watch', '--preserveWatchOutput', '--pretty', 'false']];
const plans = {
  web: [
    typeWatcher(webProjects),
    ['pnpm', ['--filter', '@hypermail/web', 'exec', 'esbuild', 'src/browser.tsx', '--bundle', '--format=esm', '--platform=browser', '--define:process.env.NODE_ENV="development"', '--sourcemap', '--outfile=dist/app.js', '--watch=forever']],
    ['pnpm', ['--filter', '@hypermail/web', 'exec', 'esbuild', 'src/pwa/service-worker.ts', '--bundle', '--format=esm', '--platform=browser', '--sourcemap', '--outfile=dist/pwa/service-worker.js', '--watch=forever']],
    ['pnpm', ['--filter', '@hypermail/web', 'exec', 'tailwindcss', '-i', 'src/styles/globals.css', '-o', 'dist/app.css', '--watch=always']],
    ['node', ['--watch', '--watch-preserve-output', 'apps/web/dist/index.js']],
  ],
  worker: [
    typeWatcher(workerProjects),
    ['node', ['--watch', '--watch-preserve-output', 'apps/worker/dist/main.js']],
  ],
};

if (!(role in plans)) {
  process.stderr.write('Usage: node infra/dev-runner.mjs <web|worker> [--plan]\n');
  process.exit(2);
}
if (planOnly) {
  process.stdout.write(`${JSON.stringify(plans[role])}\n`);
  process.exit(0);
}
if (role === 'web') await cp('apps/web/static', 'apps/web/dist', { recursive: true, force: true });

const children = plans[role].map(([command, args]) => spawn(command, args, { stdio: 'inherit', env: process.env }));
let stopping = false;
const stop = (signal, code) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill(signal);
  const pending = children.filter((child) => child.exitCode === null);
  if (pending.length === 0) process.exit(code);
  let remaining = pending.length;
  for (const child of pending) child.once('exit', () => { if (--remaining === 0) process.exit(code); });
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop(signal, 0));
for (const [index, child] of children.entries()) {
  const [command, args] = plans[role][index];
  const label = [command, ...args].join(' ');
  child.once('error', (error) => { process.stderr.write(`Development watcher failed (${label}): ${error.message}\n`); stop('SIGTERM', 1); });
  child.once('exit', (code, signal) => {
    if (!stopping) {
      process.stderr.write(`Development watcher exited (${label}; ${signal ?? String(code)}).\n`);
      stop('SIGTERM', code ?? 1);
    }
  });
}
