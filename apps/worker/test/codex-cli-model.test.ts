/* eslint-disable @typescript-eslint/no-non-null-assertion -- controlled test arrays are populated before access */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CodexCliModel } from '../src/codex-cli-model.js';

class Child extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  kill(signal?: string) { this.signals.push(signal ?? 'SIGTERM'); return true; }
  complete(code = 0) { this.emit('close', code); }
}

const result = (text = 'answer') => `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })}\n${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 2, reasoning_output_tokens: 1 } })}\n`;
const input = (extra: Record<string, unknown> = {}) => ({ prompt: [{ role: 'system', content: 'be brief' }, { role: 'user', content: [{ type: 'text', text: 'hello' }] }], ...extra }) as never;
const waitForChild = async (children: readonly Child[]) => { while (!children[0]) await new Promise((resolve) => setTimeout(resolve, 0)); };

function controlled(modelId = 'test-model', options: Record<string, unknown> = {}) {
  const children: Child[] = [];
  const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  const model = new CodexCliModel(modelId, {
    ...options,
    spawnCommand: ((command: string, args: readonly string[], spawnOptions: { cwd: string }) => {
      const child = new Child(); children.push(child); calls.push({ command, args, cwd: spawnOptions.cwd }); return child;
    }) as never,
  });
  return { model, children, calls };
}

describe('CodexCliModel', () => {
  it('translates text prompts and Codex JSONL without a shell', async () => {
    const { model, children, calls } = controlled();
    const pending = model.doGenerate(input());
    await waitForChild(children);
    children[0]!.stdout.write(result()); children[0]!.complete();
    await expect(pending).resolves.toMatchObject({ content: [{ type: 'text', text: 'answer' }], finishReason: 'stop', usage: { inputTokens: 3, cachedInputTokens: 1, outputTokens: 2, reasoningTokens: 1 } });
    expect(calls[0]).toMatchObject({ command: 'codex' });
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['exec', '--json', '--sandbox', 'read-only', '--ask-for-approval', 'never', '--skip-git-repo-check', '--ephemeral', '--model', 'test-model', 'SYSTEM:\nbe brief\n\nUSER:\nhello']));
  });

  it('omits the default model and uses output schema plus last message for JSON', async () => {
    const { model, children, calls } = controlled('default');
    const pending = model.doGenerate(input({ responseFormat: { type: 'json', schema: { type: 'object', required: ['ok'] } } }));
    await waitForChild(children);
    const schemaPath = calls[0]!.args[calls[0]!.args.indexOf('--output-schema') + 1]!;
    const outputPath = calls[0]!.args[calls[0]!.args.indexOf('--output-last-message') + 1]!;
    const schema = await readFile(schemaPath, 'utf8');
    await (await import('node:fs/promises')).writeFile(outputPath, '{"ok":true}');
    children[0]!.stdout.write(result('ignored')); children[0]!.complete();
    await expect(pending).resolves.toMatchObject({ content: [{ type: 'text', text: '{"ok":true}' }] });
    expect(schema).toBe('{"type":"object","required":["ok"]}');
    expect(calls[0]!.args).not.toContain('--model');
  });

  it('serializes subprocesses', async () => {
    const { model, children } = controlled();
    const first = model.doGenerate(input());
    const second = model.doGenerate(input());
    await waitForChild(children);
    expect(children).toHaveLength(1);
    children[0]!.stdout.write(result('first')); children[0]!.complete();
    await first;
    while (children.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(children).toHaveLength(2);
    children[1]!.stdout.write(result('second')); children[1]!.complete();
    await expect(second).resolves.toMatchObject({ content: [{ text: 'second' }] });
  });

  it('rejects unsupported tools, failures, malformed output, and bounded output', async () => {
    const unsupported = controlled().model;
    await expect(unsupported.doGenerate(input({ tools: [{ type: 'function' }] }))).rejects.toThrow('CODEX_CLI_UNSUPPORTED_TOOLS');
    const failed = controlled(); const failure = failed.model.doGenerate(input()); await waitForChild(failed.children); failed.children[0]!.stderr.write('denied'); failed.children[0]!.complete(2);
    await expect(failure).rejects.toThrow('CODEX_CLI_EXIT: denied');
    const invalid = controlled(); const malformed = invalid.model.doGenerate(input()); await waitForChild(invalid.children); invalid.children[0]!.stdout.write('not-json\n'); invalid.children[0]!.complete();
    await expect(malformed).rejects.toThrow('CODEX_CLI_INVALID_OUTPUT');
    const limited = controlled('test-model', { maxOutputBytes: 4 }); const overflow = limited.model.doGenerate(input()); await waitForChild(limited.children); limited.children[0]!.stdout.write('12345'); limited.children[0]!.complete();
    await expect(overflow).rejects.toThrow('CODEX_CLI_OUTPUT_LIMIT'); expect(limited.children[0]!.signals).toContain('SIGTERM');
  });

  it('terminates aborts and supplies a compliant final-only stream', async () => {
    const aborted = controlled('test-model', { killGraceMilliseconds: 1 }); const controller = new AbortController(); const pending = aborted.model.doGenerate(input({ abortSignal: controller.signal })); await waitForChild(aborted.children); controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(aborted.children[0]!.signals).toEqual(['SIGTERM', 'SIGKILL']);
    aborted.children[0]!.complete();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const streamed = controlled(); const response = await streamed.model.doStream(input()); await waitForChild(streamed.children); streamed.children[0]!.stdout.write(result('streamed')); streamed.children[0]!.complete();
    const parts = [];
    const reader = response.stream.getReader();
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      parts.push(part.value);
    }
    expect(parts).toEqual([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'codex-cli-result' },
      { type: 'text-delta', id: 'codex-cli-result', delta: 'streamed' },
      { type: 'text-end', id: 'codex-cli-result' },
      { type: 'finish', finishReason: 'stop', usage: { inputTokens: 3, cachedInputTokens: 1, outputTokens: 2, reasoningTokens: 1, totalTokens: undefined } },
    ]);
  });
});
