import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const image = process.env['HYPERMAIL_RUNTIME_SMOKE_IMAGE'];

describe.skipIf(!image)('native Hypermail image lifecycle', () => {
  it('serves the pinned native MCP host and exits cleanly after SIGTERM without provider egress', async () => {
    if (!image) throw new Error('An explicit isolated runtime image is required');
    const ownership = randomUUID();
    const name = `hypermail-native-runtime-${ownership}`;
    const directory = await mkdtemp('/var/tmp/hypermail-native-peer-');
    const fixture = join(directory, 'peer.mjs');
    await writeFile(fixture, `import { createServer, connect } from 'node:net';
const peer = createServer(socket => {
  socket.resume();
  socket.once('end', () => { peer.close(); });
});
await new Promise(resolve => { peer.listen(0, '127.0.0.1', resolve); });
const client = connect(peer.address().port, '127.0.0.1');
client.resume();
await new Promise(resolve => { client.once('connect', resolve); });
`, { mode: 0o444 });
    try {
      const configuration = await execute('docker', ['image', 'inspect', '--format', '{{json .Config.Env}}', image]);
      const environment: unknown = JSON.parse(configuration.stdout);
      if (!Array.isArray(environment)) throw new Error('Missing native image environment');
      const entries: unknown[] = environment;
      const configured = entries.find(entry => typeof entry === 'string' && entry.startsWith('NODE_OPTIONS='));
      const nodeOptions = typeof configured === 'string' ? configured.slice('NODE_OPTIONS='.length) : '';
      // Preserve the actual image configuration: adding the fixture must not repair a
      // missing production preload and thereby hide a Dockerfile wiring regression.
      await execute('docker', ['run', '--detach', '--name', name, '--label', `hypermail.acceptance.native-runtime=${ownership}`, '--network', 'none', '--mount', `type=bind,source=${fixture},target=/run/peer.mjs,readonly`, '--env', `NODE_OPTIONS=${nodeOptions} --import=/run/peer.mjs`, image], { timeout: 10_000 });
      // Real child/container clock: fake Vitest timers cannot advance native HTTP boot
      // or Docker's SIGTERM deadline. Retry only the actual readiness observation.
      const deadline = Date.now() + 15_000;
      for (;;) {
        try {
          const result = await execute('docker', ['exec', name, 'node', '--input-type=module', '-e', "const r=await fetch('http://127.0.0.1:3000/mcp',{headers:{accept:'application/json, text/event-stream'}});if(r.status!==400)throw Error('Native MCP not ready');console.log(r.status);"], { timeout: 2_000 });
          expect(result.stdout.trim()).toBe('400');
          break;
        } catch {
          if (Date.now() >= deadline) throw new Error('Owned native Hypermail image did not become live');
          await new Promise(resolve => { setTimeout(resolve, 50); });
        }
      }
      await execute('docker', ['stop', '--time', '45', name], { timeout: 50_000 });
      const stopped = await execute('docker', ['inspect', '--format', '{{.State.ExitCode}}', name]);
      expect(stopped.stdout.trim()).toBe('0');
    } finally {
      const owned = await execute('docker', ['inspect', '--format', '{{ index .Config.Labels "hypermail.acceptance.native-runtime" }}', name]).catch(() => undefined);
      if (owned?.stdout.trim() === ownership) await execute('docker', ['rm', '--force', name]);
      await rm(directory, { recursive: true, force: true });
    }
  }, 70_000);
});
