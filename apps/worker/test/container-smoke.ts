#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { execFileSync } from 'node:child_process';
import { createECDH } from 'node:crypto';
import { resolve } from 'node:path';

const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 900_000, ...options }).trim();
const repositoryRoot = resolve(import.meta.dirname, '../../..');
const image = `hypermail-worker-smoke-${String(process.pid)}`;
const vapid = createECDH('prime256v1');
vapid.generateKeys();
const vapidPublicKey = vapid.getPublicKey().toString('base64url');
const vapidPrivateKey = vapid.getPrivateKey().toString('base64url');
let container: string | undefined;

async function waitForHealth(): Promise<void> {
  let lastError: unknown;
  const check = "Promise.all([fetch('http://127.0.0.1:3001/live'), fetch('http://127.0.0.1:3001/ready')]).then(async ([live, ready]) => { if (live.status !== 200 || ready.status !== 503 || (await ready.json()).status !== 'not_ready') process.exit(1); })";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      run('docker', ['exec', container ?? '', 'node', '-e', check]);
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const logs = container ? run('docker', ['logs', container]) : '';
  throw new Error(`worker container did not become live and not_ready: ${String(lastError)}\n${logs}`);
}

try {
  run('docker', ['version', '--format', '{{.Server.Version}}']);
  run('docker', ['build', '--file', 'infra/Dockerfile.worker', '--tag', image, '.'], { cwd: repositoryRoot });
  container = run('docker', ['run', '--detach',
    '--env', 'DATABASE_URL=postgresql://127.0.0.1:1/hypermail',
    '--env', 'HYPERMAIL_URL=http://127.0.0.1:9/mcp', '--env', `HYPERMAIL_KEY=${'a'.repeat(16)}`, '--env', 'HYPERMAIL_PROTOCOL_VERSION=test',
    '--env', 'MODEL_PROVIDER=openai', '--env', 'MODEL_NAME=test', '--env', `MODEL_API_KEY=${'b'.repeat(16)}`,
    '--env', 'VAPID_SUBJECT=mailto:ops@example.test', '--env', `VAPID_PUBLIC_KEY=${vapidPublicKey}`, '--env', `VAPID_PRIVATE_KEY=${vapidPrivateKey}`, 
    '--env', `PUSH_SUBSCRIPTION_ENCRYPTION_KEY=${'e'.repeat(32)}`, '--env', 'AGENT_GLOBAL_CONSTRAINTS=Never send mail.', image]);
  await waitForHealth();
  if (run('docker', ['inspect', '--format', '{{.State.Running}}', container]) !== 'true') throw new Error('worker exited during degraded smoke test');
  process.stdout.write(`worker container smoke passed (${container})\n`);
} finally {
  if (container) {
    try { run('docker', ['rm', '--force', container]); } catch { /* best-effort cleanup */ }
  }
  try { run('docker', ['image', 'rm', '--force', image]); } catch { /* build or cleanup failure */ }
}
