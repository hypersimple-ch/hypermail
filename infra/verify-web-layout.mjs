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
  const asset = path === '/app.css' ? { body: stylesheet, type: 'text/css' } : path === '/layout-harness.js' ? { body: javascript, type: 'text/javascript' } : path === '/' || /^\/chat(?:\/[^/]+)?$/.test(path) ? { body: html, type: 'text/html' } : null;
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
  const startupError = (message) => new Error(`${message}${stderr.trim() ? `\nChrome stderr:\n${stderr.trim()}` : ''}`);
  const timeout = setTimeout(() => reject(startupError('Chrome did not expose DevTools in time')), 10000);
  chromeProcess.stderr.setEncoding('utf8');
  chromeProcess.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-16_384);
    const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
    if (match?.[1]) { clearTimeout(timeout); resolveUrl(match[1]); }
  });
  chromeProcess.once('error', (error) => { clearTimeout(timeout); reject(startupError(`Chrome could not start: ${error.message}`)); });
  chromeProcess.once('exit', (code) => { clearTimeout(timeout); reject(startupError(`Chrome exited before DevTools was ready (${String(code)})`)); });
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
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (result.exceptionDetails) fail(result.exceptionDetails.text + ': ' + (result.exceptionDetails.exception?.description ?? expression));
  return result.result.value;
};
const until = async (expression, label) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await delay(25);
  }
  const context = await evaluate(`({ width: innerWidth, path: location.pathname, active: document.activeElement?.outerHTML.slice(0, 300), lastClick: window.layoutLastClick, escapeEvents: window.layoutEscapeEvents, fabExpanded: document.querySelector('button[aria-label="Open Assistant"]')?.getAttribute('aria-expanded'), overlays: Array.from(document.querySelectorAll('#assistant-dialog, [data-slot="modal-backdrop"], [data-slot="modal-container"], [role="listbox"], [data-slot="select-popover"]')).map(element => ({ tag:element.tagName, attributes:Object.fromEntries(Array.from(element.attributes).map(attribute => [attribute.name, attribute.value])), animations:element.getAnimations({subtree:true}).map(animation => ({playState:animation.playState,pending:animation.pending,currentTime:animation.currentTime})) })) })`);
  fail(`${label} did not reach the expected state; ${JSON.stringify(context)}`);
};
const visibleExpression = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0)`;
const click = async selector => {
  await until(`(() => { const e = ${visibleExpression(selector)}; if(!e) return false; const r=e.getBoundingClientRect(); const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2); window.layoutLastClick = { selector:${JSON.stringify(selector)}, target:e.outerHTML.slice(0,300), hit:hit?.outerHTML.slice(0,300), x:r.x+r.width/2, y:r.y+r.height/2 }; return hit && e.contains(hit); })()`, `pointer access to ${selector}`);
  const point = await evaluate(`(() => { const e = ${visibleExpression(selector)}; if (!e) throw Error(${JSON.stringify(`Missing trigger: ${selector}`)}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }, sessionId);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }, sessionId);
};
const clickText = async (text, selector = 'button') => {
  await until(`(() => { const e=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e => e.textContent.includes(${JSON.stringify(text)}) && e.getBoundingClientRect().width > 0); if(!e) return false; const r=e.getBoundingClientRect(); const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2); window.layoutLastClick={text:${JSON.stringify(text)},target:e.outerHTML.slice(0,300),hit:hit?.outerHTML.slice(0,300),x:r.x+r.width/2,y:r.y+r.height/2}; return hit && e.contains(hit); })()`, `pointer access to ${text}`);
  const point = await evaluate(`(() => { const e=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e => e.textContent.includes(${JSON.stringify(text)}) && e.getBoundingClientRect().width > 0); if(!e) throw Error('Missing text trigger'); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }, sessionId);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }, sessionId);
};
const key = async (name, shift = false) => {
  const codes = { Tab: 9, Escape: 27, Enter: 13, ArrowDown: 40 };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: codes[name], modifiers: shift ? 8 : 0 }, sessionId);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: codes[name], modifiers: shift ? 8 : 0 }, sessionId);
};
const snapshot = () => evaluate('window.layoutMetrics()');
const run = async (screen, width, { largeText = false, mode = '', reducedMotion = false, height = 900, path = '/' } = {}) => {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' }] }, sessionId);
  const url = `http://127.0.0.1:${address.port}${path}?screen=${encodeURIComponent(screen)}&mode=${mode}&largeText=${String(largeText)}&run=${String(++nonce)}`;
  await send('Page.navigate', { url }, sessionId);
  await until('document.querySelector("#layout-result[data-ready=true]")', `${screen} at ${width}px`);
  return snapshot();
};
const near = (left, right, tolerance = 2) => Math.abs(left - right) <= tolerance;
const noOverflow = (result, label) => { if (result.document.scrollWidth !== result.document.clientWidth) fail(`${label} has document overflow (${result.document.scrollWidth}px > ${result.document.clientWidth}px)`); };
const contained = (rect, viewport, label) => { if (!rect || rect.left < -1 || rect.top < -1 || rect.right > viewport.width + 1 || rect.bottom > viewport.height + 1) fail(`${label} must fit the viewport; ${JSON.stringify({ rect, viewport })}`); };
const overlaps = (left, right) => left && right && left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
const openAssistant = async () => {
  await click('button[aria-label="Open Assistant"]');
  await until('document.querySelector("#assistant-dialog")', 'Assistant opening');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  await until('!document.querySelector("#assistant-dialog").getAnimations({ subtree: true }).some(animation => animation.playState === "running" || animation.pending)', 'Assistant entry animation completion');
  if (!await evaluate('Boolean(document.querySelector("#chat-message"))')) await clickText('Nouveau chat');
  await until('document.querySelector("#chat-message")', 'Assistant conversation fixture');
  await until('document.querySelector("#assistant-dialog").contains(document.activeElement)', 'Assistant focus readiness');
};
const closeAssistant = async () => {
  await evaluate(`(() => { window.layoutEscapeEvents = []; const capture = event => { if (event.key !== 'Escape') return; const record = { type:event.type, key:event.key, modifiers:{shift:event.shiftKey,ctrl:event.ctrlKey,alt:event.altKey,meta:event.metaKey}, target:event.target?.outerHTML?.slice(0,300), path:event.composedPath().filter(node => node instanceof Element).map(element => ({tag:element.tagName,id:element.id,slot:element.getAttribute('data-slot'),role:element.getAttribute('role')})), defaultPrevented:event.defaultPrevented }; window.layoutEscapeEvents.push(record); queueMicrotask(() => { record.defaultPrevented = event.defaultPrevented; }); }; document.addEventListener('keydown',capture,{capture:true,once:true}); document.addEventListener('keyup',capture,{capture:true,once:true}); })()`);
  await key('Escape');
  await until('!document.querySelector("#assistant-dialog") && !document.querySelector("[data-slot=modal-backdrop]") && !location.pathname.startsWith("/chat")', 'Assistant minimizing');
  await until('document.activeElement?.getAttribute("aria-label") === "Open Assistant"', 'Assistant return focus');
};

for (const width of [360, 700, 1024, 1440, 1800]) {
  const inbox = await run('inbox', width, { mode: 'utilities' });
  noOverflow(inbox, `inbox${width}`);
  if (width < 700) {
    if (inbox.mobile.labels.length !== 5 || !['Inbox', 'Drafts', 'Sent', 'Approvals', 'Activity'].every(label => inbox.mobile.labels.some(text => text?.includes(label)))) fail('all five mobile destinations must be available');
    if (inbox.mobile.targets.some(target => target.width < 44 || target.height < 44)) fail('mobile destinations must have 44px targets');
    if (!inbox.assistant.fab || inbox.assistant.fab.bottom > inbox.mobile.nav.top) fail('Assistant must clear mobile navigation');
  } else if (!inbox.compose || !inbox.rail.rect || !near(inbox.compose.width, inbox.rail.rect.width - 2 * inbox.rail.padding)) fail(`Compose must fill the rail inner width at ${width}px`);
  if (overlaps(inbox.assistant.fab, inbox.utilities)) fail('PWA utilities cover Assistant');
  const message = await run('message', width);
  noOverflow(message, `message${width}`);
  contained(message.inbox.reader, message.viewport, 'message reader');
  if (width === 700 && message.inbox.list) fail('700px must show only the selected reader');
  if (width >= 1024 && (!message.inbox.list || message.inbox.list.width < 350 || message.inbox.reader.width < 300)) fail('desktop list and reader must both have usable space');

  await run('inbox', width, { mode: 'utilities' });
  await openAssistant();
  const assistant = await snapshot();
  noOverflow(assistant, `assistant${width}`);
  contained(assistant.assistant.dialog, assistant.viewport, 'Assistant dialog');
  contained(assistant.assistant.close, assistant.viewport, 'Assistant close');
  contained(assistant.assistant.composer, assistant.viewport, 'Assistant composer');
  if (!near(assistant.assistant.dialog.left + assistant.assistant.dialog.width / 2, width / 2) || !near(assistant.assistant.dialog.top + assistant.assistant.dialog.height / 2, assistant.viewport.height / 2)) fail('Assistant must be centered');
  if (!assistant.assistant.backdrop || !assistant.assistant.blur?.includes('6px') || !assistant.assistant.dim || assistant.assistant.dim === 'rgba(0, 0, 0, 0)') fail('Assistant must blur and dim its backdrop');
  if (!(assistant.assistant.transcriptScrollHeight > assistant.assistant.transcriptClientHeight)) fail('Assistant transcript must scroll independently');
  await evaluate('document.querySelector("[data-slot=assistant-transcript]").scrollTop = 200');
  if (!await evaluate('document.querySelector("[data-slot=assistant-transcript]").scrollTop > 0')) fail('Assistant transcript did not scroll');
  const scrolled = await snapshot();
  if (!near(scrolled.assistant.composer.top, assistant.assistant.composer.top) || !near(scrolled.assistant.close.top, assistant.assistant.close.top)) fail('Transcript scrolling moved composer or close');
  for (const shift of [false, true]) for (let index = 0; index < 16; index += 1) {
    await key('Tab', shift);
    if (!await evaluate('document.querySelector("#assistant-dialog").contains(document.activeElement)')) fail('Tab focus escaped Assistant');
  }
  await click('#chat-message');
  await send('Input.insertText', { text: 'Unsent text survives minimizing' }, sessionId);
  await closeAssistant();
  await openAssistant();
  if (await evaluate('document.querySelector("#chat-message").value') !== 'Unsent text survives minimizing') fail('minimizing erased unsent text');
  await closeAssistant();

  await click('button[aria-label="Account and settings"]');
  await until('document.querySelector("[role=menu]")', 'owner menu opening');
  const ownerMenu = await snapshot();
  contained(ownerMenu.menu, ownerMenu.viewport, 'owner menu with long email');
  await key('Escape');
  await until('!document.querySelector("[role=menu]")', 'owner menu dismissal');
}

const activity = await run('activity', 360, { largeText: true });
noOverflow(activity, 'activity360-large-text');
if (!(activity.activity.filterScrollWidth > activity.activity.filterClientWidth)) fail('Activity filters must scroll locally at increased text size');
if (!activity.activity.rows.length) fail('Activity must expose card rows at 360px');
for (const row of activity.activity.rows) {
  if (row.children.some(child => child.left < row.container.left - 1 || child.right > row.container.right + 1)) fail('Activity card content must remain inside its row');
  for (let index = 1; index < row.children.length; index += 1) if (row.children[index].top < row.children[index - 1].bottom - 1) fail('Activity card content must not overlap');
}
for (const screen of ['inbox', 'compose', 'drafts', 'sent', 'pending-sends', 'settings', 'account']) noOverflow(await run(screen, 360), `${screen}360`);
const compose = await run('compose', 360);
if (!(compose.composeEditor.scroll > compose.composeEditor.client)) fail('Compose formatting toolbar must scroll locally');
if (compose.composeEditor.bold.left < compose.composeEditor.toolbar.left - 1 || compose.composeEditor.bold.right > compose.composeEditor.toolbar.right + 1) fail('Core Compose formatting controls must be initially visible');
for (const [name, color] of Object.entries({ input: compose.surfaces.input, richEditor: compose.surfaces.richEditor, select: compose.surfaces.select })) if (!color || color === compose.surfaces.page) fail(`Compose ${name} must use a contrasting surface`);

await run('inbox', 360, { largeText: true, height: 640, reducedMotion: true });
await openAssistant();
const reduced = await snapshot();
contained(reduced.assistant.dialog, reduced.viewport, 'short large-text Assistant');
contained(reduced.assistant.close, reduced.viewport, 'short large-text close');
contained(reduced.assistant.composer, reduced.viewport, 'short large-text composer');
if (reduced.assistant.animations !== 0) fail('reduced-motion Assistant must reach an immediate open state');
await closeAssistant();

await run('inbox', 1024);
await evaluate(`${visibleExpression('button[aria-label="Account and settings"]')}.focus()`);
await key('Enter');
await until('document.querySelector("[role=menu]")', 'keyboard owner menu');
await clickText('Mailboxes & agents', '[role="menuitem"]');
await until('document.querySelector("[aria-label=\\"Mailboxes & agents\\"]")', 'Mailboxes & agents navigation');
await clickText('Back to inbox');
await until('document.querySelector("[aria-label=Inbox]")', 'settings return to inbox');
await click('button[aria-label="Account and settings"]');
await until('document.querySelector("[role=menu]")', 'account menu');
await clickText('Account & security', '[role="menuitem"]');
await until('document.querySelector("[aria-label=\\"Account & security\\"]")', 'Account & security navigation');
await clickText('Back to inbox');
await until('document.querySelector("[aria-label=Inbox]")', 'account return to inbox');

await run('message', 1024);
await clickText('Discuss this mail');
await until('document.querySelector("#assistant-dialog")', 'Reader discussion');
await evaluate('history.back()');
await until('!document.querySelector("#assistant-dialog") && !location.pathname.startsWith("/chat")', 'Back from Assistant');
if (!await evaluate(`${visibleExpression('[aria-label="Message detail"]')}?.textContent.includes("Quick question about Thursday")`)) fail('Back from Assistant lost the selected Reader');
await evaluate('history.forward()');
await until('document.querySelector("#assistant-dialog")', 'Forward to Assistant');
await closeAssistant();

await run('inbox', 1024, { path: '/chat/11111111-1111-4111-8111-111111111111' });
await until('document.querySelector("#chat-message")', 'direct conversation link');
if (await evaluate('document.querySelectorAll("#assistant-dialog").length') !== 1) fail('deep link created more than one Assistant');
await click('button[aria-label="Minimize Assistant"]');
await until('location.pathname === "/" && !document.querySelector("#assistant-dialog")', 'direct conversation minimize');
if (!await evaluate(`${visibleExpression('[aria-label="Inbox"]')} !== undefined`)) fail('direct conversation minimize must reveal Inbox');

await run('inbox', 1024);
await openAssistant();
await click('#chat-message');
await send('Input.insertText', { text: 'Question resolved while minimized' }, sessionId);
await clickText('Envoyer');
await until('document.querySelector("#assistant-dialog").textContent.includes("Réponse en attente")', 'pending reply');
await closeAssistant();
const backgroundPath = await evaluate('location.pathname');
await evaluate('window.completePendingReply()');
await delay(2400);
if (await evaluate('location.pathname') !== backgroundPath || await evaluate('Boolean(document.querySelector("#assistant-dialog"))')) fail('background reply completion reopened or navigated Assistant');
await openAssistant();
await until('document.querySelector("#assistant-dialog").textContent.includes("Reply completed while minimized")', 'background reply visible on reopen');
if (await evaluate('Array.from(document.querySelectorAll("#assistant-dialog li")).filter(e => e.textContent.includes("Reply completed while minimized")).length') !== 1) fail('background reply must appear exactly once');
await closeAssistant();

await run('inbox', 360, { largeText: true });
await click('button[aria-label="Account and settings"]');
await until('document.querySelector("[role=menu]")', 'large-text owner menu');
const largeMenu = await snapshot();
noOverflow(largeMenu, 'large-text menu');
contained(largeMenu.menu, largeMenu.viewport, 'large-text owner menu');
await key('Escape');

await run('inbox', 1024);
await clickText('Approvals');
await until('document.body.textContent.includes("Awaiting approval")', 'Approvals fixture');
if (!await evaluate('Boolean(document.querySelector("[aria-label=\\"2 pending approvals\\"]"))')) fail('Approvals badge must count both authorized mailboxes');
if (!await evaluate('document.body.textContent.includes("Uncertain owner submission") && document.body.textContent.includes("Agent request 3") && document.body.textContent.includes("Sending outcomes")')) fail('Approvals must retain rejected and unknown outcomes');
await clickText('Reject send request');
await until('document.querySelector("[aria-label=\\"1 pending approvals\\"]")', 'Approvals count after rejection and refresh');
await clickText('Reject send request');
await until('!document.querySelector("[aria-label$=\\"pending approvals\\"]")', 'zero pending approvals');
if (!await evaluate('document.body.textContent.includes("No requests need your approval.") && document.body.textContent.includes("Uncertain owner submission")')) fail('zero approvals must preserve uncertain outcomes');
const unknownControls = await evaluate(`(() => { const card = Array.from(document.querySelectorAll('[data-slot="card"]')).find(e => e.textContent.includes('Uncertain owner submission')); if (!card) throw Error('Missing unknown submission card'); return Array.from(card.querySelectorAll('button')).map(button => button.textContent.trim()); })()`);
if (!unknownControls.includes('Verify provider outcome') || unknownControls.includes('Review and send') || unknownControls.includes('Confirm this exact send')) fail('unknown submission must offer read-only verification, never automatic resend');
await run('pending-sends', 1024, { mode: 'refresh-error' });
await clickText('Refresh');
await until('document.body.textContent.includes("Could not refresh approvals. Try again.")', 'Approvals refresh failure');
if (!await evaluate('document.body.textContent.includes("Agent request 1") && document.body.textContent.includes("Uncertain owner submission")')) fail('refresh failure must preserve loaded approval and outcome cards');
for (const mode of ['loading', 'load-error']) {
  await run('inbox', 1024, { mode });
  if (await evaluate('Boolean(document.querySelector("[aria-label$=\\"pending approvals\\"]"))')) fail(`${mode} must not report a known approvals count`);
}
console.log('responsive UI verification passed (360, 700, 1024, 1440, 1800px; large text, real overlay keyboard/smoke, approvals and utilities)');
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
