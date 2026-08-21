import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const web = join(root, 'apps/web');
const css = join(web, 'dist/app.css');
const fail = (message) => { throw new Error(`responsive UI verification failed: ${message}`); };
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const closeServer = (server) => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
const candidates = [process.env['CHROME_BIN'], '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
const chrome = (await Promise.all(candidates.map(async (candidate) => await exists(candidate) ? candidate : null))).find(Boolean);
if (!chrome) fail('Google Chrome or Chromium is required; set CHROME_BIN when it is outside a standard path');
if (!(await exists(css))) fail('apps/web/dist/app.css is missing; run the web build first');

const temp = await mkdtemp(join(tmpdir(), 'hypermail-layout-'));
const bundle = join(temp, 'layout-harness.js');
let server;
let chromeProcess;
let socket;

try {
  await exec('pnpm', ['--filter', '@hypermail/web', 'exec', 'esbuild', 'test/ui/layout-harness.tsx', '--bundle', '--format=esm', '--platform=browser', `--outfile=${bundle}`], { cwd: root });
  const [javascript, stylesheet] = await Promise.all([readFile(bundle), readFile(css)]);
  const html = Buffer.from('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><pre id="layout-result" hidden></pre><script type="module" src="/layout-harness.js"></script></body></html>');
  server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://layout.test').pathname;
  const asset = path === '/app.css' ? { body: stylesheet, type: 'text/css' } : path === '/layout-harness.js' ? { body: javascript, type: 'text/javascript' } : path === '/' ? { body: html, type: 'text/html' } : null;
  if (!asset) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' }); response.end(asset.body);
});
await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
const address = server.address();
if (!address || typeof address === 'string') fail('test server did not expose a TCP port');

const chromeArgs = ['--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(temp, 'chrome')}`, 'about:blank'];
if (typeof process.getuid === 'function' && process.getuid() === 0) chromeArgs.unshift('--no-sandbox');
chromeProcess = spawn(chrome, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
const debuggerUrl = await new Promise((resolveUrl, reject) => {
  let stderr = '';
  const timeout = setTimeout(() => reject(new Error('Chrome did not expose DevTools in time')), 10000);
  chromeProcess.stderr.setEncoding('utf8');
  chromeProcess.stderr.on('data', (chunk) => {
    stderr += chunk;
    const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
    if (match?.[1]) { clearTimeout(timeout); resolveUrl(match[1]); }
  });
  chromeProcess.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Chrome exited before DevTools was ready (${String(code)})`)); });
});
socket = new WebSocket(debuggerUrl);
await new Promise((resolveOpen, reject) => {
  const timeout = setTimeout(() => reject(new Error('Chrome DevTools WebSocket did not open in time')), 5000);
  socket.addEventListener('open', () => { clearTimeout(timeout); resolveOpen(); }, { once: true });
  socket.addEventListener('error', (event) => { clearTimeout(timeout); reject(new Error(`Chrome DevTools WebSocket failed: ${event.type}`)); }, { once: true });
});
let commandId = 0;
const pending = new Map();
const rejectPending = (reason) => {
  for (const callback of pending.values()) { clearTimeout(callback.timeout); callback.reject(reason); }
  pending.clear();
};
socket.addEventListener('close', () => { rejectPending(new Error('Chrome DevTools WebSocket closed')); });
socket.addEventListener('error', () => { rejectPending(new Error('Chrome DevTools WebSocket failed')); });
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return;
  const callback = pending.get(message.id); pending.delete(message.id);
  if (!callback) return;
  clearTimeout(callback.timeout);
  if (message.error) callback.reject(new Error(message.error.message)); else callback.resolve(message.result);
});
const send = (method, params = {}, sessionId) => new Promise((resolveCommand, reject) => {
  const id = ++commandId;
  const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome DevTools command timed out: ${method}`)); }, 5000);
  pending.set(id, { resolve: resolveCommand, reject, timeout });
  socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);

let nonce = 0;
const run = async (screen, width, { largeText = false } = {}) => {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  const url = `http://127.0.0.1:${address.port}/?screen=${encodeURIComponent(screen)}&largeText=${String(largeText)}&run=${String(++nonce)}`;
  await send('Page.navigate', { url }, sessionId);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await send('Runtime.evaluate', { expression: 'document.querySelector("#layout-result[data-ready=true]")?.textContent ?? ""', returnByValue: true }, sessionId);
    if (result.result.value) return JSON.parse(result.result.value);
    await delay(25);
  }
  fail(`${screen} at ${width}px did not produce layout metrics`);
};
const near = (left, right, tolerance = 1) => Math.abs(left - right) <= tolerance;
const noOverflow = (result, label) => { if (result.document.scrollWidth !== result.document.clientWidth) fail(`${label} has document overflow (${result.document.scrollWidth}px > ${result.document.clientWidth}px)`); };

  const more360 = await run('more', 360); const more700 = await run('more', 700); const more1024 = await run('more', 1024); const more1440 = await run('more', 1440); const more1800 = await run('more', 1800);
  for (const [label, result] of Object.entries({ more360, more700, more1024, more1440, more1800 })) noOverflow(result, label);
  if (more360.viewport.width !== 360 || more360.more.columns !== 1 || more360.more.buttons.some((button) => !near(button.width, more360.more.gridWidth))) fail('More must use one full-width tile column at 360px');
  if (!more360.surfaces.outlineButton || more360.surfaces.outlineButton === more360.surfaces.page) fail('Outlined More tiles must use a contrasting surface background');
  if (more700.more.columns !== 1) fail('More must remain one column at the 700px shell boundary');
  if (more1024.more.columns !== 2 || !near(more1024.more.buttons[2].width, more1024.more.gridWidth)) fail('More must use two balanced columns and a full-width third tile at 1024px');
  for (const [label, result] of Object.entries({ more1440, more1800 })) if (result.more.columns !== 3 || new Set(result.more.buttons.map((button) => button.y)).size !== 1 || !result.more.buttons.every((button) => near(button.width, result.more.buttons[0].width))) fail(`${label} must use one aligned three-tile row`);
  if (more360.mobile.navItems !== 4 || more360.mobile.composeBottom > more360.mobile.navTop) fail('mobile Compose must clear the four-item navigation bar');

  const message360 = await run('message', 360); const message1440 = await run('message', 1440);
  noOverflow(message360, 'message360'); noOverflow(message1440, 'message1440');
  if (!message360.inbox.mobileReaderWidth || message360.inbox.mobileReaderWidth > message360.document.clientWidth) fail('mobile message detail must fit the viewport');
  if (!near(message1440.inbox.width, 385) || !message1440.inbox.readerWidth) fail('desktop message selection must retain the 385px Inbox list and reader');

  const activity360 = await run('activity', 360, { largeText: true });
  noOverflow(activity360, 'activity360-large-text');
  if (!(activity360.activity.filterScrollWidth > activity360.activity.filterClientWidth)) fail('Activity filters must scroll locally at increased text size');
  if (!activity360.activity.rows.length) fail('Activity must expose card rows at 360px');
  for (const row of activity360.activity.rows) {
    if (row.children.some((child) => child.x < row.container.x - 1 || child.right > row.container.right + 1)) fail('Activity card content must remain inside its row at increased text size');
    for (let index = 1; index < row.children.length; index += 1) if (row.children[index].top < row.children[index - 1].bottom - 1) fail('Activity card status, content, and action must not overlap at increased text size');
  }

  for (const mobileScreen of ['inbox', 'compose', 'drafts', 'sent', 'pending-sends', 'settings', 'account']) noOverflow(await run(mobileScreen, 360), `${mobileScreen}360`);
  const compose360 = await run('compose', 360);
  for (const [name, color] of Object.entries({ input: compose360.surfaces.input, textarea: compose360.surfaces.textarea, select: compose360.surfaces.select })) if (!color || color === compose360.surfaces.page) fail(`Compose ${name} must use a contrasting surface background`);

  const settings1440 = await run('settings', 1440); const account1440 = await run('account', 1440);
  if (![settings1440.page.x, account1440.page.x].every((x) => near(x, more1440.page.x)) || ![settings1440.page.width, account1440.page.width].every((width) => near(width, more1440.page.width))) fail('More, Settings, and Account must share stable outer page edges');
  console.log('responsive UI verification passed (360, 700, 1024, 1440, and 1800px)');
} finally {
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  if (chromeProcess && chromeProcess.exitCode === null) {
    const exited = new Promise((resolveExit) => { chromeProcess.once('exit', resolveExit); });
    chromeProcess.kill();
    await Promise.race([exited, delay(2000)]);
  }
  if (server?.listening) await closeServer(server);
  await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
