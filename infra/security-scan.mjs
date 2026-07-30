import { spawnSync } from 'node:child_process';

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

// Dependency scanning is always available through pnpm. Container image scanning is
// intentionally performed in CI after image builds, where Trivy is installed.
run('pnpm', ['audit', '--prod', '--audit-level', 'high']);
if (process.env['SCAN_IMAGES'] === 'true') {
  run('trivy', ['image', '--exit-code', '1', '--severity', 'HIGH,CRITICAL', 'hypermail-web:scan']);
  run('trivy', ['image', '--exit-code', '1', '--severity', 'HIGH,CRITICAL', 'hypermail-worker:scan']);
}
