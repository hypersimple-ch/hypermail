import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2StreamPart } from '@ai-sdk/provider';

type LanguageModelV2GenerateResult = Awaited<ReturnType<LanguageModelV2['doGenerate']>>;

const DEFAULT_OUTPUT_LIMIT_BYTES = 1_048_576;
const DEFAULT_KILL_GRACE_MILLISECONDS = 1_000;

type CodexEvent = Readonly<{ type?: unknown; item?: { type?: unknown; text?: unknown }; usage?: { input_tokens?: unknown; cached_input_tokens?: unknown; output_tokens?: unknown; reasoning_output_tokens?: unknown }; error?: unknown }>;
type SpawnProcess = Pick<ChildProcess, 'stdout' | 'stderr' | 'on' | 'kill'>;
type SpawnCommand = (command: string, arguments_: readonly string[], options: Readonly<{ cwd: string; stdio: readonly ['ignore', 'pipe', 'pipe'] }>) => SpawnProcess;

export interface CodexCliModelOptions {
  readonly modelId: string;
  readonly command?: string;
  readonly maxOutputBytes?: number;
  readonly killGraceMilliseconds?: number;
  readonly spawnCommand?: SpawnCommand;
}

const abortError = (): Error => Object.assign(new Error('CODEX_CLI_ABORTED'), { name: 'AbortError' });
const cliError = (code: string, detail?: string): Error => new Error(detail ? `${code}: ${detail}` : code);
const token = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Converts the V2 text-only prompt subset into the one prompt accepted by `codex exec`. */
function promptText(prompt: LanguageModelV2CallOptions['prompt']): string {
  const lines: string[] = [];
  for (const message of prompt) {
    if (message.role === 'tool') throw cliError('CODEX_CLI_UNSUPPORTED_TOOLS');
    if (message.role === 'system') {
      lines.push(`SYSTEM:\n${message.content}`);
      continue;
    }
    const text: string[] = [];
    for (const part of message.content) {
      if (part.type !== 'text') throw cliError(part.type === 'tool-call' || part.type === 'tool-result' ? 'CODEX_CLI_UNSUPPORTED_TOOLS' : 'CODEX_CLI_UNSUPPORTED_PROMPT');
      text.push(part.text);
    }
    lines.push(`${message.role.toUpperCase()}:\n${text.join('')}`);
  }
  return lines.join('\n\n');
}

/**
 * A deliberately narrow LanguageModelV2 adapter for the locally installed Codex CLI.
 * Codex has no streaming event for assistant deltas, so doStream emits one completed result.
 */
export class CodexCliModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;
  readonly provider = 'codex-cli';
  readonly supportedUrls = {};
  private readonly command: string;
  private readonly maxOutputBytes: number;
  private readonly killGraceMilliseconds: number;
  private readonly spawnCommand: SpawnCommand;
  private pending: Promise<void> = Promise.resolve();

  constructor(readonly modelId: string, options: Omit<CodexCliModelOptions, 'modelId'> = {}) {
    this.command = options.command ?? 'codex';
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
    this.killGraceMilliseconds = options.killGraceMilliseconds ?? DEFAULT_KILL_GRACE_MILLISECONDS;
    this.spawnCommand = options.spawnCommand ?? (spawn as unknown as SpawnCommand);
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes < 1) throw new Error('maxOutputBytes must be a positive integer');
    if (!Number.isSafeInteger(this.killGraceMilliseconds) || this.killGraceMilliseconds < 0) throw new Error('killGraceMilliseconds must be a non-negative integer');
  }

  doGenerate(options: LanguageModelV2CallOptions): Promise<LanguageModelV2GenerateResult> {
    return this.singleFlight(async () => this.generate(options));
  }

  doStream(options: LanguageModelV2CallOptions) {
    const id = 'codex-cli-result';
    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start: (controller) => {
        void this.doGenerate(options).then((result) => {
          controller.enqueue({ type: 'stream-start', warnings: result.warnings });
          controller.enqueue({ type: 'text-start', id });
          const text = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
          if (text) controller.enqueue({ type: 'text-delta', id, delta: text });
          controller.enqueue({ type: 'text-end', id });
          controller.enqueue({ type: 'finish', finishReason: result.finishReason, usage: result.usage });
          controller.close();
        }, (error: unknown) => { controller.error(error); });
      },
    });
    return Promise.resolve({ stream });
  }

  private singleFlight<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async generate(options: LanguageModelV2CallOptions): Promise<LanguageModelV2GenerateResult> {
    if (options.tools?.length) throw cliError('CODEX_CLI_UNSUPPORTED_TOOLS');
    const prompt = promptText(options.prompt);
    const directory = await mkdtemp(join(tmpdir(), 'hypermail-codex-'));
    const schemaPath = join(directory, 'output-schema.json');
    const outputPath = join(directory, 'last-message.txt');
    const responseFormat = options.responseFormat;
    const structured = responseFormat?.type === 'json';
    try {
      const args = ['--ask-for-approval', 'never', 'exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules'];
      if (this.modelId !== 'default') args.push('--model', this.modelId);
      if (structured) {
        await writeFile(schemaPath, JSON.stringify(responseFormat.schema ?? {}), { mode: 0o600 });
        args.push('--output-schema', schemaPath, '--output-last-message', outputPath);
      }
      args.push(prompt);
      const completed = await this.execute(args, directory, options.abortSignal);
      const events = completed.stdout.split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line) as CodexEvent; } catch { throw cliError('CODEX_CLI_INVALID_OUTPUT'); }
      });
      const failure = events.find((event) => event.type === 'turn.failed' || event.type === 'error');
      if (failure) throw cliError('CODEX_CLI_FAILED', typeof failure.error === 'string' ? failure.error : undefined);
      const usageEvent = events.find((event) => event.type === 'turn.completed');
      const message = [...events].reverse().find((event) => event.type === 'item.completed' && event.item?.type === 'agent_message');
      const text = structured ? await readFile(outputPath, 'utf8') : typeof message?.item?.text === 'string' ? message.item.text : undefined;
      if (text === undefined) throw cliError('CODEX_CLI_MISSING_RESPONSE');
      const usage = usageEvent?.usage;
      return { content: [{ type: 'text', text }], finishReason: 'stop', usage: { inputTokens: token(usage?.input_tokens), cachedInputTokens: token(usage?.cached_input_tokens), outputTokens: token(usage?.output_tokens), reasoningTokens: token(usage?.reasoning_output_tokens), totalTokens: undefined }, warnings: [] };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private execute(args: readonly string[], cwd: string, signal: AbortSignal | undefined): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError()); return; }
      let child: SpawnProcess;
      try { child = this.spawnCommand(this.command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); return; }
      let stdout = ''; let stderr = ''; let stdoutBytes = 0; let stderrBytes = 0; let settled = false; let aborted = false; let limitError: Error | undefined; let abortTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error, value?: { stdout: string; stderr: string }, clearKillTimer = true) => {
        if (settled) return;
        settled = true;
        if (clearKillTimer && abortTimer) clearTimeout(abortTimer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else if (value) resolve(value);
        else reject(new Error('CODEX_CLI_INTERNAL_ERROR'));
      };
      const terminate = () => { child.kill('SIGTERM'); abortTimer = setTimeout(() => { child.kill('SIGKILL'); }, this.killGraceMilliseconds); };
      const onAbort = () => { aborted = true; terminate(); };
      const append = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
        const text = chunk.toString();
        const bytes = Buffer.byteLength(text);
        const total = target === 'stdout' ? stdoutBytes + bytes : stderrBytes + bytes;
        if (total > this.maxOutputBytes) { limitError ??= cliError('CODEX_CLI_OUTPUT_LIMIT'); terminate(); return; }
        if (target === 'stdout') { stdout += text; stdoutBytes = total; } else { stderr += text; stderrBytes = total; }
      };
      child.stdout?.on('data', (chunk: Buffer | string) => { append('stdout', chunk); });
      child.stderr?.on('data', (chunk: Buffer | string) => { append('stderr', chunk); });
      child.on('error', (error) => { finish(error instanceof Error ? error : new Error(String(error))); });
      child.on('close', (code) => {
        if (settled) { if (abortTimer) clearTimeout(abortTimer); return; }
        if (aborted) finish(abortError());
        else if (limitError) finish(limitError);
        else if (code !== 0) finish(cliError('CODEX_CLI_EXIT', stderr || `exit ${String(code ?? 'unknown')}`));
        else finish(undefined, { stdout, stderr });
      });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export function createCodexCliModel(options: CodexCliModelOptions): CodexCliModel {
  return new CodexCliModel(options.modelId, options);
}
