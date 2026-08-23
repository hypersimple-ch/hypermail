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
const envContract = read('packages/contracts/src/env.ts');
const envExample = read('.env.example');
const hindsightEnvExample = read('.env.hindsight.example');

const hindsightWorkerFields = [
  'HINDSIGHT_URL', 'HINDSIGHT_API_KEY', 'HINDSIGHT_EXPECTED_VERSION',
  'HINDSIGHT_REQUEST_TIMEOUT_MS', 'HINDSIGHT_MAX_FILE_BYTES',
];
for (const field of hindsightWorkerFields) {
  if (!envContract.includes(field)) fail(`worker environment contract must define ${field}`);
  if (field !== 'HINDSIGHT_API_KEY' && !envExample.includes(`${field}=`)) fail(`local environment example must define ${field}`);
}
if (!/HINDSIGHT_EXPECTED_VERSION: z\.literal\('0\.9\.1'\)/.test(envContract)) fail('worker must fail closed on the Hindsight 0.9.1 version contract');
if (/HINDSIGHT_API_LLM_API_KEY=/.test(envExample)) fail('shared local environment must not contain the Hindsight LLM secret');
if (!/HINDSIGHT_API_LLM_PROVIDER=/.test(hindsightEnvExample) || !/HINDSIGHT_API_LLM_MODEL=/.test(hindsightEnvExample) || !/HINDSIGHT_API_LLM_API_KEY=/.test(hindsightEnvExample) || !/HINDSIGHT_API_EMBEDDINGS_PROVIDER=local/.test(hindsightEnvExample) || !/HINDSIGHT_API_RERANKER_PROVIDER=local/.test(hindsightEnvExample)) {
  fail('dedicated Hindsight env template must configure its LLM and local full-image models');
}

for (const [name, compose] of [['VPS', vps], ['Dokploy', dokploy]]) {
  if (!/private:\n    internal: true/.test(compose)) fail(`${name} compose must use an internal private network`);
  for (const service of ['worker', 'postgres', 'hypermail']) {
    const section = compose.match(new RegExp(`^  ${service}:\\n([\\s\\S]*?)(?=\\n  [a-z]|\\nnetworks:)`, 'm'))?.[1] ?? '';
    if (/^    ports:/m.test(section)) fail(`${name} ${service} must not publish host ports`);
    if (!/networks: \[private\]/.test(section)) fail(`${name} ${service} must be private-only`);
  }
  if (!/postgres-data:\s*\{\}/.test(compose) || !/hypermail-data:\s*\{\}/.test(compose) || !/hindsight-data:\s*\{\}/.test(compose)) {
    fail(`${name} compose must declare PostgreSQL, Hypermail, and Hindsight persistent volumes`);
  }
  if (!/attachment-temp:\s*\{\}/.test(compose) || !/ATTACHMENT_TEMP_DIRECTORY: \/var\/lib\/hypermail-attachments/.test(compose) || !/TMPDIR: \/var\/lib\/hypermail-attachments/.test(compose) || !/install -d -m 0700 -o 10001 -g 10001/.test(compose)) {
    fail(`${name} compose must provision the private shared attachment directory`);
  }
  if (!/healthcheck:/.test(compose)) fail(`${name} compose must define dependency health checks`);
  const backup = compose.match(/^  backup:\n([\s\S]*?)(?=\n  [a-z]|\nnetworks:)/m)?.[1] ?? '';
  if (!/profiles: \[backup\]/.test(backup) || !/hypermail-data:\/var\/lib\/hypermail:ro/.test(backup) || !/networks: \[private\]/.test(backup)) {
    fail(`${name} backup must be an opt-in private job with read-only Hypermail state`);
  }
  const hindsight = compose.match(/^  hindsight:\n([\s\S]*?)(?=\n  [a-z]|\nnetworks:)/m)?.[1] ?? '';
  if (!/image: \$\{HINDSIGHT_IMAGE:\?set HINDSIGHT_IMAGE to an immutable Hindsight 0\.9\.1 digest\}/.test(hindsight)
    || /^    ports:/m.test(hindsight) || !/networks: \[private, egress\]/.test(hindsight)) {
    fail(`${name} Hindsight must use an immutable approved 0.9.1 digest with private ingress, provider egress, and no published ports`);
  }
  if (!/HINDSIGHT_ENABLE_CP: "false"/.test(hindsight) || !/HINDSIGHT_API_WORKER_ID: hypermail-hindsight-0/.test(hindsight) || !/hindsight-data:\/home\/hindsight\/\.pg0/.test(hindsight) || !/127\.0\.0\.1:8888\/health/.test(hindsight)) {
    fail(`${name} Hindsight must disable its control plane and use stable persistent healthy embedded state`);
  }
  if (!/HINDSIGHT_ENV_FILE/.test(hindsight) || !/mem_limit:/.test(hindsight) || !/cpus:/.test(hindsight) || !/HINDSIGHT_API_FILE_CONVERSION_MAX_BATCH_SIZE_MB: 50/.test(hindsight) || !/HINDSIGHT_API_FILE_CONVERSION_MAX_BATCH_SIZE: 5/.test(hindsight)) {
    fail(`${name} Hindsight must receive dedicated LLM config and bounded resources/files`);
  }
  const worker = compose.match(/^  worker:\n([\s\S]*?)(?=\n  [a-z]|\nnetworks:)/m)?.[1] ?? '';
  if (!/hindsight:\n        condition: service_healthy/.test(worker)) fail(`${name} worker must wait for healthy Hindsight`);
  if (!/ATTACHMENT_TEMP_DIRECTORY: \/var\/lib\/hypermail-attachments/.test(worker)
    || !/attachment-temp:\/var\/lib\/hypermail-attachments/.test(worker)) {
    fail(`${name} worker must share the private attachment volume for bounded Hindsight file ingestion`);
  }
  const web = compose.match(/^  web:\n([\s\S]*?)(?=\n  [a-z]|\nnetworks:)/m)?.[1] ?? '';
  if (/HINDSIGHT_ENV_FILE|HINDSIGHT_API_LLM|hindsight-data/.test(web)) fail(`${name} web must not receive Hindsight secrets or state`);
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
const localHindsight = local.match(/^  hindsight:\n([\s\S]*?)(?=\nnetworks:)/m)?.[1] ?? '';
if (!/image: ghcr\.io\/vectorize-io\/hindsight:0\.9\.1/.test(localHindsight) || !/HINDSIGHT_ENABLE_CP: "false"/.test(localHindsight) || !/hindsight-data:\/home\/hindsight\/\.pg0/.test(localHindsight) || /^    ports:/m.test(localHindsight) || !/networks: \[private, egress\]/.test(localHindsight)) {
  fail('local Hindsight must use pinned full 0.9.1 privately with persistent embedded state and provider egress');
}
const localWorker = local.match(/^  worker:\n([\s\S]*?)(?=\n  [a-z]|\nnetworks:)/m)?.[1] ?? '';
if (!/hindsight:\n        condition: service_healthy/.test(localWorker) || !/hindsight-data:\s*\{\}/.test(local)) fail('local worker must wait for persistent healthy Hindsight');
if (!/ATTACHMENT_TEMP_DIRECTORY: \/var\/lib\/hypermail-attachments/.test(localWorker)
  || !/attachment-temp:\/var\/lib\/hypermail-attachments/.test(localWorker)) {
  fail('local worker must share the private attachment volume for bounded Hindsight file ingestion');
}
const localWeb = local.match(/^  web:\n([\s\S]*?)(?=\n  [a-z]|\nnetworks:)/m)?.[1] ?? '';
if (/HINDSIGHT_ENV_FILE|HINDSIGHT_API_LLM|hindsight-data/.test(localWeb)) fail('local web must not receive Hindsight LLM secrets or state');
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
