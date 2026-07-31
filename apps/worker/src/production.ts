import PgBoss from 'pg-boss';
import postgres, { type Sql } from 'postgres';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { MastraSourceHistory, PostgresDecisionPersistence, TriageService, createMastraPostgresStorage, mastraDecisionModel } from '@hypermail/agent';
import { workerEnvSchema } from '@hypermail/contracts';
import { createPostgresClient, type ManagedSqlClient } from '@hypermail/db';
import { HypermailReadClient, type HypermailMcpHttpClient } from '@hypermail/hypermail';
import { DeliverPolicyConsumer, DurablePolicyRecovery, HypermailPrivateMutationTransport, PgBossPolicyDispatcher, PostgresPolicyActionInputStore, PostgresPolicyPlanner, createPolicyExecutor } from './policy.js';
import { NotificationWorker, PostgresNotificationPersistence, PushSubscriptionAesCodec, WebPushVapidTransport, type NotificationInput, type VapidPushTransport } from '@hypermail/notifications';
import { DispatchRecovery, IngestionWorker, LeaseScheduler, type Clock } from './ingestion.js';
import { HypermailInboxProvider } from './hypermail-provider.js';
import { LifecycleScheduler, LifecycleWorker } from './lifecycle/retention.js';
import { PostgresLifecycleStore } from './lifecycle/postgres-store.js';
import { PgBossDeliveryQueue, type PgBossLike } from './pg-boss-queue.js';
import { PostgresIngestionStore, type SqlClient as WorkerSqlClient } from './postgres-store.js';
import { createCodexCliModel, type CodexCliModel } from './codex-cli-model.js';
import { ClaimingAgentConsumer, DurableNotificationRecovery, type AgentJobHandler, type AgentJobStore, type BossJob, type BossRuntime, type JobConsumer, type NotificationDispatchStore, type NotificationDispatcher, type QueueName, type WorkerEnvironment, type WorkerRuntimeDependencies, WorkerRuntime, defaultHolderId } from './runtime.js';

/** pg-boss v10 invokes a worker with a batch, while WorkerRuntime deliberately consumes one job. */
type PgBossV10 = PgBossLike & {
  start(): Promise<void>;
  createQueue(name: string): Promise<unknown>;
  stop(options?: { graceful?: boolean; timeout?: number }): Promise<void>;
  work(name: string, handler: (jobs: readonly BossJob[]) => Promise<void>): Promise<unknown>;
};

export class PgBossRuntime implements BossRuntime {
  constructor(private readonly boss: PgBossV10) {}
  start(): Promise<void> { return this.boss.start(); }
  async createQueue(name: QueueName): Promise<void> { await this.boss.createQueue(name); }
  stop(options?: { graceful?: boolean; timeout?: number }): Promise<void> { return this.boss.stop(options); }
  async work(name: QueueName, handler: (job: BossJob) => Promise<void>): Promise<void> {
    await this.boss.work(name, async (jobs) => { for (const job of jobs) await handler(job); });
  }
}

const clock: Clock = { now: () => new Date(), sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) };

/** Adapts the shared managed client without leaking its readonly result arrays into legacy worker ports. */
const workerSql = (database: Pick<ManagedSqlClient, 'query' | 'transaction'>): WorkerSqlClient => ({
  query: (async (statement, values) => {
    const result = await database.query(statement, values);
    return { rows: [...result.rows] };
  }) as WorkerSqlClient['query'],
  transaction: async <T>(operation: (client: WorkerSqlClient) => Promise<T>) => database.transaction((client) => operation(workerSql(client))),
});

/** Durable input projection. Attachment data is metadata from our database, never provider bytes. */
export type ClaimedAgentJob = Readonly<{
  id: string; activityId: string; accountId: string; accountEmail: string; messageId: string;
  providerMessageId: string; sender: string; subject: string; receivedAt: string | Date;
  attachments: { filename: string; mediaType: string; sizeBytes: number }[]; attempt: number;
}>;

type AgentJobRow = Omit<ClaimedAgentJob, 'attachments'> & { attachments: unknown };
const isAttachmentMetadata = (value: unknown): value is { filename: string; mediaType: string; sizeBytes: number } => {
  if (value === null || typeof value !== 'object') return false;
  const attachment = value as Record<string, unknown>;
  const filename = attachment['filename'];
  const mediaType = attachment['mediaType'];
  const sizeBytes = attachment['sizeBytes'];
  return typeof filename === 'string' && typeof mediaType === 'string' && typeof sizeBytes === 'number' && Number.isInteger(sizeBytes) && sizeBytes >= 0;
};
const attachmentMetadata = (value: unknown): ClaimedAgentJob['attachments'] => Array.isArray(value) ? value.filter(isAttachmentMetadata) : [];

export class PostgresAgentJobStore implements AgentJobStore<ClaimedAgentJob> {
  constructor(private readonly db: ManagedSqlClient, private readonly bodyRetentionDays = 90) {}
  async claim(jobId: string): Promise<ClaimedAgentJob | null> {
    const result = await this.db.query<AgentJobRow>(`
      WITH candidate AS (
        SELECT j.id FROM app.agent_jobs j
        WHERE j.id = $1 AND j.available_at <= now() AND j.state IN ('pending', 'running')
        FOR UPDATE SKIP LOCKED
      ), claimed AS (
        UPDATE app.agent_jobs j SET state = 'running', attempt = CASE WHEN j.state = 'pending' THEN j.attempt + 1 ELSE j.attempt END, updated_at = now()
        FROM candidate c WHERE j.id = c.id
        RETURNING j.id, j.activity_id, j.attempt
      )
      SELECT c.id, c.activity_id AS "activityId", a.account_id AS "accountId", ac.email AS "accountEmail",
             m.id AS "messageId", m.provider_message_id AS "providerMessageId",
             coalesce(m.sender->>'name', m.sender->>'address', '') AS sender, m.subject, m.received_at AS "receivedAt",
             coalesce(jsonb_agg(jsonb_build_object('filename', att.filename, 'mediaType', att.media_type, 'sizeBytes', att.size_bytes)) filter (where att.id is not null), '[]'::jsonb) AS attachments,
             c.attempt
      FROM claimed c JOIN app.activities a ON a.id = c.activity_id JOIN app.accounts ac ON ac.id = a.account_id
      JOIN app.messages m ON m.id = a.message_id LEFT JOIN app.attachments att ON att.message_id = m.id
      GROUP BY c.id, c.activity_id, a.account_id, ac.email, m.id, m.provider_message_id, m.sender, m.subject, m.received_at, c.attempt
    `, [jobId]);
    const row = result.rows[0];
    return row ? { ...row, attachments: attachmentMetadata(row.attachments) } : null;
  }
  async failAdapter(job: ClaimedAgentJob, code: string): Promise<void> {
    await this.db.transaction(async (db) => {
      await db.query(`update app.agent_jobs set state = 'failed', last_error_code = $2, updated_at = now() where id = $1`, [job.id, code]);
      await db.query(`update app.activities set state = 'failed', last_error_code = $2, updated_at = now() where id = $1`, [job.activityId, code]);
    });
  }
  async cacheBody(messageId: string, bodyText: string): Promise<void> {
    await this.db.query(`insert into app.message_bodies (message_id, text_body, purge_after) values ($1, $2, now() + make_interval(days => $3)) on conflict (message_id) do update set text_body = excluded.text_body, cached_at = now(), purge_after = excluded.purge_after`, [messageId, bodyText, this.bodyRetentionDays]);
  }
}

/** Reads provider content only after the durable job is claimed, then passes scoped text to triage. */
export class DeliverAgentConsumer implements AgentJobHandler<ClaimedAgentJob> {
  constructor(private readonly client: Pick<HypermailReadClient, 'initialize' | 'readMessage'>, private readonly triage: Pick<TriageService, 'triage'>, private readonly store: Pick<PostgresAgentJobStore, 'failAdapter' | 'cacheBody'>, private readonly globalConstraints: string, private readonly planner?: Pick<PostgresPolicyPlanner, 'plan'>) {}
  async evaluate(job: ClaimedAgentJob): Promise<void> {
    let bodyText: string;
    try {
      await this.client.initialize();
      const message = await this.client.readMessage(job.accountEmail, job.providerMessageId, 'text');
      bodyText = message.body ?? '';
      // Caching is optional; a cache outage must not prevent a durable decision.
      await this.store.cacheBody(job.messageId, bodyText).catch(() => undefined);
    } catch (error) {
      await this.store.failAdapter(job, 'AGENT_INPUT_UNAVAILABLE');
      throw error;
    }
    const outcome = await this.triage.triage({ activityId: job.activityId, accountId: job.accountId, attempt: job.attempt,
      email: { messageId: job.messageId, from: job.sender, subject: job.subject, receivedAt: new Date(job.receivedAt).toISOString(), bodyText, attachments: job.attachments },
      globalConstraints: this.globalConstraints });
    if (outcome.decision.state === 'actionable') await this.planner?.plan(job.activityId, job.attempt, outcome.decision);
  }
}

type ProviderModel = ReturnType<ReturnType<typeof createOpenAI>> | CodexCliModel;
/** Constructs a configured AI SDK model without probing or sending content. */
export function createModel(environment: Pick<WorkerEnvironment, 'MODEL_PROVIDER' | 'MODEL_API_KEY' | 'MODEL_NAME'>): ProviderModel {
  if (environment.MODEL_PROVIDER === 'codex-cli') return createCodexCliModel({ modelId: environment.MODEL_NAME });
  if (environment.MODEL_API_KEY === undefined) throw new Error('MODEL_API_KEY_REQUIRED');
  switch (environment.MODEL_PROVIDER) {
    case 'openai': return createOpenAI({ apiKey: environment.MODEL_API_KEY })(environment.MODEL_NAME);
    case 'anthropic': return createAnthropic({ apiKey: environment.MODEL_API_KEY })(environment.MODEL_NAME);
    case 'google': return createGoogleGenerativeAI({ apiKey: environment.MODEL_API_KEY })(environment.MODEL_NAME);
  }
}

export class PostgresNotificationDispatchStore implements NotificationDispatchStore {
  constructor(private readonly db: ManagedSqlClient) {}
  async pendingNotificationIds(limit: number): Promise<readonly string[]> {
    const result = await this.db.query<{ id: string }>(`select id from app.logical_notifications where state in ('pending', 'failed') order by created_at, id limit $1`, [limit]);
    return result.rows.map((row) => row.id);
  }
}

export class PgBossNotificationDispatcher implements NotificationDispatcher {
  constructor(private readonly boss: PgBossLike) {}
  async dispatch(notificationId: string): Promise<void> {
    const id = await this.boss.send('notification.deliver', { notificationId }, { singletonKey: `notification:deliver:${notificationId}` });
    if (!id) throw new Error('pg-boss did not return a notification job id');
  }
}

export class PostgresNotificationInputStore {
  constructor(private readonly db: ManagedSqlClient) {}
  async get(notificationId: string): Promise<NotificationInput | null> {
    const result = await this.db.query<{ activity_id: string; user_id: string; sender_label: string; subject: string; status_label: string }>(
      `select n.activity_id, ua.user_id, n.sender_label, n.subject, n.status_label
       from app.logical_notifications n
       join app.activities a on a.id = n.activity_id
       join app.user_accounts ua on ua.account_id = a.account_id
       where n.id = $1
       order by ua.user_id
       limit 1`, [notificationId],
    );
    const row = result.rows[0];
    return row ? { notificationId, activityId: row.activity_id, userId: row.user_id, senderLabel: row.sender_label, subject: row.subject, statusLabel: row.status_label } : null;
  }
}

export class DeliverNotificationConsumer implements JobConsumer {
  constructor(private readonly input: PostgresNotificationInputStore, private readonly worker: NotificationWorker) {}
  async consume(payload: Parameters<JobConsumer['consume']>[0]): Promise<void> {
    if (!('notificationId' in payload)) throw new Error('QUEUE_PAYLOAD_INVALID');
    const input = await this.input.get(payload.notificationId);
    if (input) await this.worker.deliver(input);
  }
}

/** Throwing lets pg-boss retry while the logical notification remains durable. */
export class UnavailableConsumer implements JobConsumer {
  constructor(private readonly code: string) {}
  consume(): Promise<void> { return Promise.reject(new Error(this.code)); }
}

export interface ProductionFactories {
  createDatabase?(url: string): ManagedSqlClient;
  createBoss?(url: string): PgBossV10;
  createHypermail?(environment: WorkerEnvironment): HypermailReadClient;
  createNotificationTransport?(environment: WorkerEnvironment): VapidPushTransport;
  /** Test seam: avoids creating provider and Mastra/Postgres clients. */
  createTriageService?(environment: WorkerEnvironment): Pick<TriageService, 'triage'>;
  holderId?(): string;
}

/** Production composition: policy writes are constrained to the private transport below. */
export function composeWorkerRuntime(environment: WorkerEnvironment, factories: ProductionFactories = {}): WorkerRuntime {
  // Keep the shared schema as the source of truth even for direct composition callers.
  workerEnvSchema.parse(environment);
  const database = (factories.createDatabase ?? createPostgresClient)(environment.DATABASE_URL);
  const rawBoss = (factories.createBoss ?? ((url: string) => new PgBoss({ connectionString: url }) as unknown as PgBossV10))(environment.DATABASE_URL);
  const client = (factories.createHypermail ?? ((env: WorkerEnvironment) => new HypermailReadClient({ endpoint: env.HYPERMAIL_URL, protocolVersion: env.HYPERMAIL_PROTOCOL_VERSION, headers: { authorization: `Bearer ${env.HYPERMAIL_KEY}` } })))(environment);
  let hypermailInitialization: ReturnType<HypermailReadClient['initialize']> | undefined;
  const ensureHypermail = (): ReturnType<HypermailReadClient['initialize']> => { hypermailInitialization ??= client.initialize(); return hypermailInitialization; };
  const initializedHypermail = {
    initialize: ensureHypermail,
    readMessage: async (...input: Parameters<HypermailReadClient['readMessage']>) => { await ensureHypermail(); return client.readMessage(...input); },
    establishBaseline: async (...input: Parameters<HypermailReadClient['establishBaseline']>) => { await ensureHypermail(); return client.establishBaseline(...input); },
    pollNewInbox: async (...input: Parameters<HypermailReadClient['pollNewInbox']>) => { await ensureHypermail(); return client.pollNewInbox(...input); },
    inbox: async (...input: Parameters<HypermailReadClient['inbox']>) => { await ensureHypermail(); return client.inbox(...input); },
  };
  const boss = new PgBossRuntime(rawBoss);
  const sql = workerSql(database);
  const ingestionStore = new PostgresIngestionStore(sql);
  const dispatchRecovery = new DispatchRecovery(ingestionStore, new PgBossDeliveryQueue(rawBoss));
  const holderId = (factories.holderId ?? defaultHolderId)();
  const ingestion = new LeaseScheduler(new IngestionWorker(ingestionStore, new HypermailInboxProvider(initializedHypermail), dispatchRecovery, clock), ingestionStore, clock, holderId, environment.POLL_INTERVAL_SECONDS * 1000);
  const lifecycleStore = new PostgresLifecycleStore(sql);
  const lifecycle = new LifecycleScheduler(new LifecycleWorker(lifecycleStore, clock, { bodyRetentionDays: environment.BODY_RETENTION_DAYS }), lifecycleStore, clock, holderId, environment.LIFECYCLE_INTERVAL_SECONDS * 1000);
  const notificationRecovery = new DurableNotificationRecovery(new PostgresNotificationDispatchStore(database), new PgBossNotificationDispatcher(rawBoss));
  let closeAgentResources: () => Promise<void> = () => Promise.resolve();
  const triage = factories.createTriageService?.(environment) ?? (() => {
    const decisionSql: Sql = postgres(environment.DATABASE_URL);
    const storage = createMastraPostgresStorage(environment.DATABASE_URL);
    const model = createModel(environment);
    const memory = new Memory({ storage, options: { observationalMemory: { enabled: true, model } } });
    const agent = new Agent({ id: 'hypermail-triage', name: 'hypermail-triage', instructions: 'Produce structured triage decisions only.', model, memory });
    closeAgentResources = async () => {
      const closers = [decisionSql, storage].flatMap((resource) => {
        const close = (resource as unknown as { close?: () => Promise<void> | void; end?: () => Promise<void> | void }).close
          ?? (resource as unknown as { end?: () => Promise<void> | void }).end;
        return close ? [Promise.resolve(close.call(resource))] : [];
      });
      await Promise.allSettled(closers);
    };
    return new TriageService({ model: mastraDecisionModel(agent), persistence: new PostgresDecisionPersistence(decisionSql), sourceHistory: new MastraSourceHistory(memory), modelProvider: environment.MODEL_PROVIDER, modelName: environment.MODEL_NAME });
  })();
  const policyDispatcher = new PgBossPolicyDispatcher(rawBoss);
  const policyMcp = (client as unknown as { transport?: Pick<HypermailMcpHttpClient, 'call'> }).transport;
  const policyTransport = new HypermailPrivateMutationTransport(database, policyMcp, ensureHypermail);
  const policyExecutor = createPolicyExecutor(database, policyTransport, environment.INCORRECT_MUTATION_THRESHOLD);
  const policyRecovery = new DurablePolicyRecovery(database, policyDispatcher);
  const policyPlanner = new PostgresPolicyPlanner(database, policyDispatcher);
  const agentStore = new PostgresAgentJobStore(database, environment.BODY_RETENTION_DAYS);
  const agentConsumer = new ClaimingAgentConsumer(agentStore, new DeliverAgentConsumer(initializedHypermail, triage, agentStore, environment.AGENT_GLOBAL_CONSTRAINTS, policyPlanner));
  const notificationPersistence = new PostgresNotificationPersistence(database, new PushSubscriptionAesCodec(environment.PUSH_SUBSCRIPTION_ENCRYPTION_KEY));
  const notificationTransport = (factories.createNotificationTransport ?? ((env: WorkerEnvironment) => new WebPushVapidTransport({ subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY })))(environment);
  const notificationWorker = new NotificationWorker(notificationPersistence, notificationTransport);
  const notificationConsumer = new DeliverNotificationConsumer(new PostgresNotificationInputStore(database), notificationWorker);
  const policyConsumer = new DeliverPolicyConsumer(new PostgresPolicyActionInputStore(database), policyExecutor);
  const dependencies: WorkerRuntimeDependencies = {
    boss, ingestion, lifecycle, dispatchRecovery: { recover: () => dispatchRecovery.dispatch() }, notificationRecovery, policyRecovery,
    agentConsumer, notificationConsumer, policyConsumer,
    closeDatabase: async () => { await closeAgentResources(); await database.close(); },
    probes: {
      database: async () => { await database.query('select 1'); return true; },
      hypermail: async () => { await ensureHypermail(); return true; },
      // Provider construction is the readiness boundary; probes never send email content or requests.
      model: () => Promise.resolve(true),
      notifications: () => Promise.resolve(true),
      // Hypermail's durable draft response contract is still unverified; keep release readiness closed.
      policy: () => Promise.resolve(false),
    },
  };
  return new WorkerRuntime(environment, dependencies);
}
