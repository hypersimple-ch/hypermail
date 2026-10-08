import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const compose = ['compose', '--env-file', '.env', '-f', 'infra/compose.local.yaml', '-f', 'infra/compose.dev.yaml'];
const run = (args, capture = false) => {
  const result = spawnSync('docker', args, { cwd: root, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout;
};

const configuration = JSON.parse(run([...compose, 'config', '--format', 'json'], true));
const dataKeys = ['postgres-data', 'hypermail-data', 'hindsight-data', 'attachment-temp'];
const dataVolumes = dataKeys.map((key) => {
  const volume = configuration.volumes[key];
  if (!volume || volume.external || volume.name !== `${configuration.name}_${key}`) {
    throw new Error(`Refusing to reset non-project data volume: ${key}`);
  }
  return volume.name;
});

const available = new Set(run(['volume', 'ls', '--format', '{{.Name}}'], true).trim().split('\n'));
const existing = dataVolumes.filter((name) => available.has(name));
if (existing.length > 0) {
  const volumes = JSON.parse(run(['volume', 'inspect', ...existing], true));
  for (const volume of volumes) {
    if (volume.Labels?.['com.docker.compose.project'] !== configuration.name) {
      throw new Error(`Refusing to reset volume not owned by ${configuration.name}: ${volume.Name}`);
    }
  }
}

process.stdout.write(`Resetting user data for ${configuration.name}; preserving env/config files and Codex login.\n`);
run([...compose, 'down', '--remove-orphans']);
if (existing.length > 0) run(['volume', 'rm', ...existing]);
process.stdout.write('User data reset complete. Start the clean stack with pnpm dev.\n');
