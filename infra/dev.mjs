import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const compose = ['docker', 'compose', '--env-file', '.env', '-f', 'infra/compose.local.yaml', '-f', 'infra/compose.dev.yaml'];
const forced = process.argv.includes('--rebuild');
const planOnly = process.argv.includes('--plan');
const inputs = [
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'infra/Dockerfile.dev',
  'infra/dev-runner.mjs', 'infra/worker-entrypoint.sh',
];
for (const directory of ['apps', 'packages']) {
  for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
    const manifest = `${directory}/${entry.name}/package.json`;
    if (entry.isDirectory()) {
      try { readFileSync(resolve(root, manifest)); inputs.push(manifest); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  }
}
inputs.sort();
const digest = createHash('sha256');
for (const file of inputs) digest.update(file).update('\0').update(readFileSync(resolve(root, file))).update('\0');
const inputHash = digest.digest('hex');
const environment = { ...process.env, DEV_INPUT_HASH: inputHash };
const run = (args) => {
  const result = spawnSync(compose[0], [...compose.slice(1), ...args], { cwd: root, env: environment, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
if (!planOnly) {
  const configuration = spawnSync(compose[0], [...compose.slice(1), 'config', '--format', 'json'],
    { cwd: root, env: environment, encoding: 'utf8' });
  if (configuration.error) throw configuration.error;
  if (configuration.status !== 0) {
    process.stderr.write(configuration.stderr);
    process.exit(configuration.status ?? 1);
  }
  const services = JSON.parse(configuration.stdout).services;
  const serverVersion = services.hindsight.image.match(/:(\d+\.\d+\.\d+)$/)?.[1];
  if (!serverVersion || services.worker.environment.HINDSIGHT_EXPECTED_VERSION !== serverVersion) {
    process.stderr.write('Hindsight worker/server versions differ. Validate native retain/recall, then either migrate a cold-backup copy or explicitly discard disposable local memory before updating HINDSIGHT_EXPECTED_VERSION in .env. Never start the new image against an unprotected existing volume.\n');
    process.exit(1);
  }
}
const images = ['hypermail-local-dev-web', 'hypermail-local-dev-worker', 'hypermail-local-dev-migrate'];
const imageHash = (image) => {
  const result = spawnSync('docker', ['image', 'inspect', '--format', '{{ index .Config.Labels "org.hypermail.dev-input-hash" }}', image], { cwd: root, env: environment, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
};
const staleImages = images.filter((image) => imageHash(image) !== inputHash);
if (planOnly) {
  process.stdout.write(`${JSON.stringify({ inputHash, rebuild: forced || staleImages.length > 0, staleImages })}\n`);
  process.exit(0);
}
if (forced || staleImages.length > 0) {
  process.stdout.write(`Preparing development images (${forced ? 'forced rebuild' : 'dependencies changed or images missing'})…\n`);
  run(['build', 'web', 'worker', 'migrate']);
}
const child = spawn(compose[0], [...compose.slice(1), 'up', '--watch'], { cwd: root, env: environment, stdio: 'inherit' });
child.once('error', (error) => { process.stderr.write(`Unable to start development Compose: ${error.message}\n`); process.exit(1); });
child.once('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
