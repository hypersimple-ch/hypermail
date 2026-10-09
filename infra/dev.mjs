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
  const config = JSON.parse(configuration.stdout);
  const services = config.services;
  const serverVersion = services.hindsight.image.match(/:(\d+\.\d+\.\d+)$/)?.[1];
  if (!serverVersion || services.worker.environment.HINDSIGHT_EXPECTED_VERSION !== serverVersion) {
    process.stderr.write('Hindsight worker/server versions differ. Validate native retain/recall, then either migrate a cold-backup copy or explicitly discard disposable local memory before updating HINDSIGHT_EXPECTED_VERSION in .env. Never start the new image against an unprotected existing volume.\n');
    process.exit(1);
  }
  // Docker can retain running endpoints after the host brings their bridge down.
  // Compose's normal `up` reuses them; recreate only this project's topology.
  if (process.platform === 'linux') {
    const networks = spawnSync('docker', ['network', 'ls', '--filter', `label=com.docker.compose.project=${config.name}`, '--format', '{{.ID}}'],
      { cwd: root, encoding: 'utf8' });
    if (networks.error) throw networks.error;
    if (networks.status !== 0) {
      process.stderr.write(networks.stderr);
      process.exit(networks.status ?? 1);
    }
    const ids = networks.stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length > 0) {
      const inspection = spawnSync('docker', ['network', 'inspect', ...ids], { cwd: root, encoding: 'utf8' });
      if (inspection.error) throw inspection.error;
      if (inspection.status !== 0) {
        process.stderr.write(inspection.stderr);
        process.exit(inspection.status ?? 1);
      }
      const broken = JSON.parse(inspection.stdout).filter((network) => {
        if (network.Driver !== 'bridge' || Object.keys(network.Containers ?? {}).length === 0) return false;
        const bridge = network.Options?.['com.docker.network.bridge.name'] ?? `br-${network.Id.slice(0, 12)}`;
        try {
          return (Number(readFileSync(`/sys/class/net/${bridge}/flags`, 'utf8')) & 1) === 0;
        } catch (error) {
          // A remote Docker daemon has no corresponding local sysfs interface.
          if (error?.code === 'ENOENT') return false;
          throw error;
        }
      });
      if (broken.length > 0) {
        process.stdout.write(`Recreating inactive development networks (${broken.map((network) => network.Name).join(', ')}); preserving all data volumes.\n`);
        run(['down']);
      }
    }
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
