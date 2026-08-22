import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (file) => readFileSync(resolve(root, file), 'utf8');
const fail = (message) => {
  throw new Error(`deployment verification failed: ${message}`);
};

const local = read('infra/compose.local.yaml');
const vps = read('infra/compose.vps.yaml');
const dokploy = read('infra/dokploy/compose.yaml');
const webDockerfile = read('infra/Dockerfile.web');
const workerDockerfile = read('infra/Dockerfile.worker');
const hypermailDockerfile = read('infra/Dockerfile.hypermail');
const devCompose = read('infra/compose.dev.yaml');
const devDockerfile = read('infra/Dockerfile.dev');
const devLauncher = read('infra/dev.mjs');
const devRunner = read('infra/dev-runner.mjs');
const rootPackage = read('package.json');
const hypermailPackage = read('apps/hypermail/package.json');

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
if (!/CMD \["node", "dist\/main\.js"\]/.test(workerDockerfile) || !/127\.0\.0\.1:3001\/live/.test(workerDockerfile) || !/test -x \/opt\/app\/node_modules\/\.bin\/codex/.test(workerDockerfile) || !/ENTRYPOINT \["\/usr\/local\/bin\/worker-entrypoint"\]/.test(workerDockerfile)) {
  fail('worker image must retain the Codex executable, use its non-root entrypoint, and probe private liveness');
}
const workerEntrypoint = read('infra/worker-entrypoint.sh');
if (!/install -d -m 0700 -o hypermail -g hypermail/.test(workerEntrypoint) || !/\[ ! -e "\$codex_home\/auth\.json" \] && \[ -f "\$seed_auth" \]/.test(workerEntrypoint) || !/exec su-exec hypermail/.test(workerEntrypoint) || /cat |echo .*auth|printf .*auth/.test(workerEntrypoint)) {
  fail('worker entrypoint must privately seed missing Codex auth and start the process non-root');
}
if (!/target: migrate/.test(local) || !/condition: service_completed_successfully/.test(local) || !/codex-home:\s*\{\}/.test(local) || !/source: "\$\{CODEX_AUTH_FILE:-\$\{HOME\}\/\.codex\/auth\.json\}"/.test(local) || !/target: \/run\/codex-seed\/auth\.json/.test(local) || !/read_only: true/.test(local)) {
  fail('local compose must use a private migration job and a read-only host Codex auth seed with persistent Codex state');
}
if (!/127\.0\.0\.1:\$\{LOCAL_HTTP_PORT:-8080\}:80/.test(local)) fail('local proxy must remain loopback-only');
const localHypermail = local.match(/^  hypermail:\n([\s\S]*?)(?=\nnetworks:)/m)?.[1] ?? '';
if (!/networks: \[private, egress\]/.test(localHypermail) || /^    ports:/m.test(localHypermail)) fail('local Hypermail must have private ingress and provider egress without host ports');
if (!/"hypermail-mcp": "0\.7\.26"/.test(hypermailPackage) || !/pnpm --filter @hypermail\/runtime deploy --prod/.test(hypermailDockerfile) || !/hypermail-mcp", "--http"/.test(hypermailDockerfile) || !/127\.0\.0\.1:3000\/mcp/.test(hypermailDockerfile)) {
  fail('Hypermail must build its pinned workspace runtime as a private HTTP service');
}
if (/HYPERMAIL_IMAGE|HYPERMAIL_ENV_FILE/.test(local) || !/dockerfile: infra\/Dockerfile\.hypermail/.test(local) || !/127\.0\.0\.1:3000\/mcp/.test(local)) {
  fail('local compose must build the pinned Hypermail runtime without a separate image or env file');
}
if (!/FROM build AS migrate/.test(webDockerfile) || !/CMD \["pnpm", "--filter", "@hypermail\/db", "db:migrate"\]/.test(webDockerfile)) {
  fail('web image must expose a migration target reusing workspace build dependencies');
}
for (const [name, dockerfile] of [['web', webDockerfile], ['worker', workerDockerfile], ['hypermail', hypermailDockerfile]]) {
  if (!/FROM .* AS build/.test(dockerfile) || !/FROM node:/.test(dockerfile)) fail(`${name} image must be multi-stage`);
  if (!/pnpm install --frozen-lockfile/.test(dockerfile) || !/pnpm .* deploy --prod/.test(dockerfile)) {
    fail(`${name} image must build from the pnpm workspace`);
  }
  if ((!/USER hypermail/.test(dockerfile) && name !== 'worker') || !/HEALTHCHECK/.test(dockerfile)) {
    fail(`${name} image must run non-root and define a health check`);
  }
}

if (!/"dev": "node infra\/dev\.mjs"/.test(rootPackage) || !/"dev:rebuild": "node infra\/dev\.mjs --rebuild"/.test(rootPackage)) {
  fail('local development must use the dependency-aware Compose Watch launcher');
}
if (!/compose\.dev\.yaml/.test(devLauncher) || !/up', '--watch'/.test(devLauncher) || !/org\.hypermail\.dev-input-hash/.test(devLauncher) || !/DEV_INPUT_HASH/.test(devLauncher)) {
  fail('development launcher must rebuild only stale dependency images and then use Compose Watch');
}
if (!/target: web/.test(devCompose) || !/target: worker/.test(devCompose) || !/target: migrate/.test(devCompose) || !/action: sync/.test(devCompose) || !/action: sync\+restart/.test(devCompose) || !/action: rebuild/.test(devCompose)) {
  fail('development Compose override must watch sources and retain web, worker, and migration targets');
}
if (!/npm_config_inject_workspace_packages=false/.test(devDockerfile) || !/FROM workspace AS web/.test(devDockerfile) || !/FROM workspace AS worker/.test(devDockerfile) || !/FROM workspace AS migrate/.test(devDockerfile) || !/USER hypermail/.test(devDockerfile)) {
  fail('development image must use live workspace links, non-root processes, and separate service targets');
}
if (!/tsc', '-b'/.test(devRunner) || !/--watch/.test(devRunner) || !/esbuild/.test(devRunner) || !/tailwindcss/.test(devRunner) || !/apps\/worker\/dist\/main\.js/.test(devRunner)) {
  fail('development runner must watch TypeScript, browser assets, web, and worker entrypoints');
}

console.log('deployment static verification passed');
