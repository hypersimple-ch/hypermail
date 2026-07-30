import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (file) => readFileSync(resolve(root, file), 'utf8');
const fail = (message) => {
  throw new Error(`deployment verification failed: ${message}`);
};

const vps = read('infra/compose.vps.yaml');
const dokploy = read('infra/dokploy/compose.yaml');
const webDockerfile = read('infra/Dockerfile.web');
const workerDockerfile = read('infra/Dockerfile.worker');

for (const [name, compose] of [['VPS', vps], ['Dokploy', dokploy]]) {
  if (!/private:\n    internal: true/.test(compose)) fail(`${name} compose must use an internal private network`);
  for (const service of ['worker', 'postgres', 'hypermail']) {
    const section = compose.match(new RegExp(`^  ${service}:\\n([\\s\\S]*?)(?=\\n  [a-z]|\\nnetworks:)`, 'm'))?.[1] ?? '';
    if (/^    ports:/m.test(section)) fail(`${name} ${service} must not publish host ports`);
    if (!/networks: \[private\]/.test(section)) fail(`${name} ${service} must be private-only`);
  }
  if (!/postgres-data:\s*\{\}/.test(compose) || !/hypermail-data:\s*\{\}/.test(compose)) {
    fail(`${name} compose must declare PostgreSQL and Hypermail persistent volumes`);
  }
  if (!/attachment-temp:\s*\{\}/.test(compose) || !/ATTACHMENT_TEMP_DIRECTORY: \/var\/lib\/hypermail-attachments/.test(compose) || !/TMPDIR: \/var\/lib\/hypermail-attachments/.test(compose) || !/install -d -m 0700 -o 10001 -g 10001/.test(compose)) {
    fail(`${name} compose must provision the private shared attachment directory`);
  }
  if (!/healthcheck:/.test(compose)) fail(`${name} compose must define dependency health checks`);
  const backup = compose.match(/^  backup:\n([\s\S]*?)(?=\n  [a-z]|\nnetworks:)/m)?.[1] ?? '';
  if (!/profiles: \[backup\]/.test(backup) || !/hypermail-data:\/var\/lib\/hypermail:ro/.test(backup) || !/networks: \[private\]/.test(backup)) {
    fail(`${name} backup must be an opt-in private job with read-only Hypermail state`);
  }
  if (!/backup_database_key/.test(compose) || !/backup_state_key/.test(compose) || !/backup_alert_webhook/.test(compose)) {
    fail(`${name} compose must mount distinct backup keys and a failure-alert secret`);
  }
  if (!/env_file:/.test(compose) || !/POSTGRES_PASSWORD_FILE/.test(compose)) {
    fail(`${name} compose must reference service secrets and a PostgreSQL password file`);
  }
}

if (!/  proxy:[\s\S]*?\n    ports:/m.test(vps)) fail('VPS compose must publish only the proxy');
if (!/traefik\.enable=true/.test(dokploy) || /\n    ports:/m.test(dokploy)) {
  fail('Dokploy compose must route web through Traefik without host port bindings');
}
if (!/CMD \["node", "dist\/main\.js"\]/.test(workerDockerfile) || !/127\.0\.0\.1:3001\/live/.test(workerDockerfile)) {
  fail('worker image must run the operational main entrypoint and probe private liveness');
}
for (const [name, dockerfile] of [['web', webDockerfile], ['worker', workerDockerfile]]) {
  if (!/FROM .* AS build/.test(dockerfile) || !/FROM node:/.test(dockerfile)) fail(`${name} image must be multi-stage`);
  if (!/pnpm install --frozen-lockfile/.test(dockerfile) || !/pnpm .* deploy --prod/.test(dockerfile)) {
    fail(`${name} image must build from the pnpm workspace`);
  }
  if (!/USER hypermail/.test(dockerfile) || !/HEALTHCHECK/.test(dockerfile)) {
    fail(`${name} image must run non-root and define a health check`);
  }
}

console.log('deployment static verification passed');
