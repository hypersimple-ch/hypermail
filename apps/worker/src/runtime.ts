import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { workerEnvSchema, type AgentEvaluateJob, type WorkerEnv } from '@hypermail/contracts';
import { liveness, readiness, type DependencyState, type WorkerDependency } from './health.js';
import type { Clock } from './ingestion.js';

/** The MCP protocol literal is deployment-owned and intentionally not guessed. */
export type WorkerEnvironment = Readonly<WorkerEnv>;

const workerEnvironmentNames = [
  'NODE_ENV', 'DATABASE_URL', 'HYPERMAIL_URL', 'HYPERMAIL_KEY', 'HYPERMAIL_PROTOCOL_VERSION', 'HYPERMAIL_TENANT_ROUTES',
  'HINDSIGHT_URL', 'HINDSIGHT_API_KEY', 'HINDSIGHT_EXPECTED_VERSION', 'HINDSIGHT_REQUEST_TIMEOUT_MS',
  'HINDSIGHT_MAX_FILE_BYTES',
  'ATTACHMENT_TEMP_DIRECTORY', 'MODEL_PROVIDER', 'MODEL_NAME', 'MODEL_API_KEY', 'VAPID_SUBJECT', 'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY', 'PUSH_SUBSCRIPTION_ENCRYPTION_KEY', 'AGENT_GLOBAL_CONSTRAINTS', 'HEALTH_PORT', 'POLL_INTERVAL_SECONDS',
  'LIFECYCLE_INTERVAL_SECONDS', 'SHUTDOWN_TIMEOUT_SECONDS', 'BODY_RETENTION_DAYS',
  'OAUTH_RETENTION_HOURS', 'SESSION_RETENTION_DAYS', 'TASK_PAYLOAD_RETENTION_DAYS', 'OPERATIONAL_TEXT_RETENTION_DAYS',
  'LIFECYCLE_BATCH_SIZE', 'USER_TASK_RATE_PER_MINUTE', 'USER_TASK_CONCURRENCY', 'USER_PENDING_TASK_QUOTA',
  'INCORRECT_MUTATION_THRESHOLD',
] as const;

/** Parses only declared worker settings before any network connection is attempted. */
export function parseWorkerEnvironment(values: Readonly<Record<string, string | undefined>>): WorkerEnvironment {
  const selected = Object.fromEntries(workerEnvironmentNames.flatMap((name) => values[name] === undefined ? [] : [[name, values[name]]]));
  const parsed = workerEnvSchema.safeParse(selected);
  if (!parsed.success) {
    const name = parsed.error.issues[0]?.path.join('.') || 'environment';
    throw new Error(`Invalid environment variables: ${name}`);
  }
  return parsed.data;
}

export type QueueName = 'agent.evaluate' | 'notification.deliver' | 'policy.execute';
export type QueuePayload = Readonly<AgentEvaluateJob> | Readonly<{ notificationId: string }> | Readonly<{ actionId: string }>;
export interface BossJob { readonly data: unknown; }
export interface BossRuntime { start(): Promise<void>; createQueue(name: QueueName): Promise<void>; stop(options?: { graceful?: boolean; timeout?: number }): Promise<void>; work(name: QueueName, handler: (job: BossJob) => Promise<void>): Promise<void>; }
export interface Scheduler { start(): Promise<void>; stop(): void; }
export interface Recovery { recover(): Promise<void>; }
export interface JobConsumer { consume(payload: QueuePayload): Promise<void>; }
/** A durable agent job must be claimed from the database before model work starts. */
export interface AgentJobStore<Job> { claim(jobId: string, userId?: string): Promise<Job | null>; }
export interface AgentJobHandler<Job> { evaluate(job: Job): Promise<void>; }
export class ClaimingAgentConsumer<Job> implements JobConsumer {
  constructor(private readonly store: AgentJobStore<Job>, private readonly handler: AgentJobHandler<Job>) {}
  async consume(payload: QueuePayload): Promise<void> {
    if (!('jobId' in payload)) throw new Error('QUEUE_PAYLOAD_INVALID');
    const job = await this.store.claim(payload.jobId, 'userId' in payload ? payload.userId : undefined);
    if (job !== null) await this.handler.evaluate(job);
  }
}
/** Replays durable notification rows; the sender is responsible for queue singleton keys. */
export interface NotificationDispatchStore { pendingNotificationIds(limit: number): Promise<readonly string[]>; }
export interface NotificationDispatcher { dispatch(notificationId: string): Promise<void>; }
export class DurableNotificationRecovery implements Recovery {
  constructor(private readonly store: NotificationDispatchStore, private readonly dispatcher: NotificationDispatcher, private readonly limit = 100) {}
  async recover(): Promise<void> { for (const notificationId of await this.store.pendingNotificationIds(this.limit)) await this.dispatcher.dispatch(notificationId); }
}
export type AutonomousCapability = 'archive' | 'recoverable_trash' | 'move' | 'mark_read' | 'mark_unread' | 'draft_create' | 'draft_edit';
const autonomousCapabilities = new Set<AutonomousCapability>(['archive', 'recoverable_trash', 'move', 'mark_read', 'mark_unread', 'draft_create', 'draft_edit']);
/** The policy boundary has no send/delete/admin escape hatch. */
export function requireAutonomousCapability(value: string): AutonomousCapability {
  if (!autonomousCapabilities.has(value as AutonomousCapability)) throw new Error('POLICY_CAPABILITY_FORBIDDEN');
  return value as AutonomousCapability;
}
export interface RuntimeProbe { (): Promise<boolean>; }
export interface WorkerRuntimeDependencies {
  readonly boss: BossRuntime; readonly ingestion: Scheduler; readonly lifecycle: Scheduler; readonly mailboxMemoryEvents?: Scheduler; readonly dispatchRecovery: Recovery; readonly notificationRecovery: Recovery; readonly policyRecovery: Recovery; readonly agentTaskRecovery?: Recovery;
  readonly agentConsumer: JobConsumer; readonly notificationConsumer: JobConsumer; readonly policyConsumer: JobConsumer;
  readonly closeDatabase: () => Promise<void>; readonly probes: Readonly<Partial<Record<WorkerDependency, RuntimeProbe>>>;
  readonly clock?: Clock; readonly holderId?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
/** Rejects malformed, extra-field, and cross-queue payloads before domain code sees them. */
export function parseQueuePayload(name: QueueName, raw: unknown): QueuePayload {
  if (!isRecord(raw)) throw new Error('QUEUE_PAYLOAD_INVALID');
  if (name === 'agent.evaluate') {
    const keys = Object.keys(raw).sort();
    const legacy = keys.length === 1 && keys[0] === 'jobId';
    const tenantQualified = keys.length === 2 && keys[0] === 'jobId' && keys[1] === 'userId';
    if ((!legacy && !tenantQualified) || !id(raw['jobId']) || (tenantQualified && !id(raw['userId']))) throw new Error('QUEUE_PAYLOAD_INVALID');
    return tenantQualified ? { jobId: raw['jobId'], userId: raw['userId'] as string } : { jobId: raw['jobId'] };
  }
  const field = name === 'notification.deliver' ? 'notificationId' : 'actionId';
  if (Object.keys(raw).length !== 1 || !id(raw[field])) throw new Error('QUEUE_PAYLOAD_INVALID');
  return { [field]: raw[field] } as QueuePayload;
}

const dependencies = (): DependencyState => ({ database: false, queue: false, hypermail: false, hindsight: false, scheduler: false, model: false, notifications: false, policy: false });
export class WorkerRuntime {
  private readonly status: Record<WorkerDependency, boolean> = dependencies(); private server: Server | undefined; private stopping = false;
  private notificationTimer: ReturnType<typeof setInterval> | undefined; private hindsightProbeTimer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly environment: WorkerEnvironment, private readonly deps: WorkerRuntimeDependencies) {}
  get dependencyState(): DependencyState { return { ...this.status }; }
  async start(): Promise<void> {
    // Exact version/feature readiness gates every queue consumer and scheduler.
    this.status.hindsight = await this.probe('hindsight');
    if (!this.status.hindsight) throw new Error('HINDSIGHT_UNAVAILABLE');
    const server = createServer((request, response) => {
      const body = request.url === '/live' ? liveness() : request.url === '/ready' ? readiness(this.status) : null;
      response.writeHead(body ? (request.url === '/ready' && body.status === 'not_ready' ? 503 : 200) : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(body ? JSON.stringify(body) : '');
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.environment.HEALTH_PORT, '127.0.0.1', resolve); });
    try {
      await this.deps.boss.start();
      for (const name of ['agent.evaluate', 'notification.deliver', 'policy.execute'] as const) await this.deps.boss.createQueue(name);
      await Promise.all([
        this.deps.boss.work('agent.evaluate', async ({ data }) => { await this.deps.agentConsumer.consume(parseQueuePayload('agent.evaluate', data)); }),
        this.deps.boss.work('notification.deliver', async ({ data }) => { await this.deps.notificationConsumer.consume(parseQueuePayload('notification.deliver', data)); }),
        this.deps.boss.work('policy.execute', async ({ data }) => { await this.deps.policyConsumer.consume(parseQueuePayload('policy.execute', data)); }),
      ]);
      this.status.queue = true;
    } catch { this.status.queue = false; }
    const recover = (): Promise<unknown[]> => Promise.allSettled([
      this.deps.dispatchRecovery.recover(), this.deps.notificationRecovery.recover(), this.deps.policyRecovery.recover(),
      this.deps.agentTaskRecovery?.recover() ?? Promise.resolve(),
    ]);
    await recover();
    this.notificationTimer = setInterval(() => { void recover(); }, this.environment.LIFECYCLE_INTERVAL_SECONDS * 1000);
    void this.deps.ingestion.start().catch(() => { this.status.scheduler = false; });
    void this.deps.lifecycle.start().catch(() => { this.status.scheduler = false; });
    void this.deps.mailboxMemoryEvents?.start().catch(() => { this.status.scheduler = false; });
    this.status.scheduler = true;
    for (const dependency of ['database', 'hypermail', 'model', 'notifications', 'policy'] as const) this.status[dependency] = await this.probe(dependency);
    this.hindsightProbeTimer = setInterval(() => { void this.probe('hindsight').then((ready) => { this.status.hindsight = ready; }); }, 30_000);
  }
  private async probe(dependency: WorkerDependency): Promise<boolean> { try { return await (this.deps.probes[dependency]?.() ?? Promise.resolve(dependency === 'scheduler' || dependency === 'queue')); } catch { return false; } }
  async shutdown(): Promise<void> {
    if (this.stopping) return; this.stopping = true; if (this.notificationTimer) clearInterval(this.notificationTimer);
    if (this.hindsightProbeTimer) clearInterval(this.hindsightProbeTimer);
    this.deps.ingestion.stop(); this.deps.lifecycle.stop(); this.deps.mailboxMemoryEvents?.stop(); this.status.scheduler = false;
    await Promise.allSettled([this.closeServer(), this.deps.boss.stop({ graceful: true, timeout: this.environment.SHUTDOWN_TIMEOUT_SECONDS * 1000 })]);
    await this.deps.closeDatabase(); this.status.database = false; this.status.queue = false;
  }
  private closeServer(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) this.server.close(() => { resolve(); });
      else resolve();
    });
  }
}

/** Installs one bounded signal path; repeated signals never start a second shutdown. */
export function installShutdown(runtime: WorkerRuntime, timeoutMilliseconds: number, exit: (code: number) => never = (code) => { process.exit(code); }): void {
  let stopping = false;
  const stop = (): void => { if (stopping) return; stopping = true; const timer = setTimeout(() => { exit(1); }, timeoutMilliseconds); void runtime.shutdown().then(() => { clearTimeout(timer); exit(0); }).catch(() => { clearTimeout(timer); exit(1); }); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}

/** Compose and start the process without treating unavailable optional adapters as fatal. */
export async function bootstrapFromEnvironment(values: Readonly<Record<string, string | undefined>> = process.env): Promise<WorkerRuntime> {
  const environment = parseWorkerEnvironment(values);
  const { composeWorkerRuntime } = await import('./production.js');
  const runtime = composeWorkerRuntime(environment);
  await runtime.start();
  installShutdown(runtime, environment.SHUTDOWN_TIMEOUT_SECONDS * 1000);
  return runtime;
}

export const defaultHolderId = (): string => `${String(process.pid)}:${randomUUID()}`;
