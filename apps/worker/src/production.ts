import { createHash } from 'node:crypto';
import PgBoss from 'pg-boss';
import postgres, { type Sql } from 'postgres';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { MastraSourceHistory, PostgresDecisionPersistence, TriageService, createMastraPostgresStorage, mastraDecisionModel } from '@hypermail/agent';
import { workerEnvSchema } from '@hypermail/contracts';
import { AgentTaskStore, createPostgresClient, type ManagedSqlClient } from '@hypermail/db';
import { HypermailReadClient, createTenantHypermailSessionProvider, parseTenantHypermailRoutes, SingleOwnerTenantClient, TenantHypermailClientCache, type HypermailMcpHttpClient } from '@hypermail/hypermail';
import { DeliverPolicyConsumer, DurablePolicyRecovery, HypermailPrivateMutationTransport, PgBossPolicyDispatcher, PostgresPolicyActionInputStore, PostgresPolicyPlanner, createPolicyExecutor } from './policy.js';
import { NotificationWorker, PostgresNotificationPersistence, PushSubscriptionAesCodec, WebPushVapidTransport, type NotificationInput, type VapidPushTransport } from '@hypermail/notifications';
import { DispatchRecovery, IngestionWorker, LeaseScheduler, type Clock } from './ingestion.js';
import { HypermailInboxProvider } from './hypermail-provider.js';
import { LifecycleScheduler, LifecycleWorker } from './lifecycle/retention.js';
import { PostgresLifecycleStore } from './lifecycle/postgres-store.js';
import { PgBossDeliveryQueue, type PgBossLike } from './pg-boss-queue.js';
import { PostgresIngestionStore, type SqlClient as WorkerSqlClient } from './postgres-store.js';
import { createCodexCliModel, type CodexCliModel } from './codex-cli-model.js';
import { AgentTaskRecovery } from './agent-task-delivery.js';
import { PostgresOperationalGuard } from './operational-safety.js';
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
  id: string; activityId: string; userId: string; accountId: string; accountEmail: string; messageId: string;
  providerMessageId: string; sender: string; subject: string; receivedAt: string | Date;
  attachments: { filename: string; mediaType: string; sizeBytes: number }[]; attempt: number; runId?: string;
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

function deterministicWorkUuid(seed: string): string {
  const hex=createHash('sha256').update(seed).digest('hex');
  const variant = ['8', '9', 'a', 'b'][Number.parseInt(hex.charAt(16), 16) & 3] ?? '8';
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class PostgresAgentJobStore implements AgentJobStore<ClaimedAgentJob> {
  constructor(private readonly db: ManagedSqlClient, private readonly bodyRetentionDays = 90) {}
  async claim(jobId: string, userId?: string): Promise<ClaimedAgentJob | null> {
    return this.db.transaction(async (db) => {
      const result = await db.query<AgentJobRow & {
        jobState: string; runId: string | null; assignmentId: string | null; assignmentRevision: number | null;
        managerKind: string | null; automaticEnabled: boolean | null; grantId: string | null;
        grantRevision: number | null; grantState: string | null; grantModes: string[] | null;
        grantCapabilities: string[] | null; safetyRevision: number | null; safetyModes: string[] | null;
        safetyCapabilities: string[] | null;
      }>(`with locked_job as (select id from app.agent_jobs where id=$1 for update)
        select j.id, j.activity_id as "activityId", j.state as "jobState", j.agent_run_id as "runId",
          ac.user_id as "userId", a.account_id as "accountId", ac.email as "accountEmail",
          m.id as "messageId", m.provider_message_id as "providerMessageId",
          coalesce(m.sender->>'name',m.sender->>'address','') as sender, m.subject,
          m.received_at as "receivedAt", coalesce(jsonb_agg(jsonb_build_object(
            'filename',att.filename,'mediaType',att.media_type,'sizeBytes',att.size_bytes))
            filter(where att.id is not null),'[]'::jsonb) as attachments, j.attempt,
          ma.id as "assignmentId", ma.revision as "assignmentRevision", ma.manager_kind as "managerKind",
          ma.automatic_processing_enabled as "automaticEnabled", g.id as "grantId", g.revision as "grantRevision",
          g.state as "grantState", g.invocation_modes as "grantModes", g.capabilities as "grantCapabilities",
          s.revision as "safetyRevision", s.invocation_modes as "safetyModes", s.capabilities as "safetyCapabilities"
        from locked_job locked join app.agent_jobs j on j.id=locked.id join app.activities a on a.id=j.activity_id
        join app.accounts ac on ac.id=a.account_id join app.messages m on m.id=a.message_id
        left join app.attachments att on att.message_id=m.id
        left join app.mailbox_manager_assignments ma on ma.user_id=ac.user_id and ma.account_id=a.account_id
        left join app.agent_capability_grants g on g.user_id=ac.user_id and g.account_id=a.account_id
          and g.manager_kind=ma.manager_kind and g.agent_connection_id is not distinct from ma.agent_connection_id
        left join app.agent_safety_ceiling s on s.singleton=true
        where j.id=$1::uuid and ($2::uuid is null or ac.user_id=$2::uuid) and j.available_at<=now()
          and j.state IN ('pending', 'running')
        group by j.id,j.activity_id,j.state,j.agent_run_id,ac.user_id,a.account_id,ac.email,m.id,
          m.provider_message_id,m.sender,m.subject,m.received_at,j.attempt,ma.id,ma.revision,
          ma.manager_kind,ma.automatic_processing_enabled,g.id,g.revision,g.state,g.invocation_modes,
          g.capabilities,s.revision,s.invocation_modes,s.capabilities`, [jobId, userId]);
      const row = result.rows[0];
      if (!row) return null;

      // Compatibility authority is explicit and fail-closed: embedded Mastra receives only
      // current automatic Mastra assignments backed by a current active automatic mail.read
      // grant and safety ceiling. External/none Managers never fall back to Mastra.
      const allowed = row.managerKind === 'mastra' && row.automaticEnabled === true
        && row.grantState === 'active' && row.grantModes?.includes('automatic') === true
        && row.grantCapabilities?.includes('mail.read') === true
        && row.safetyModes?.includes('automatic') === true && row.safetyCapabilities?.includes('mail.read') === true;
      if (!allowed || !row.assignmentId || !row.assignmentRevision || !row.grantId || !row.grantRevision || !row.safetyRevision) {
        const reason = row.managerKind === 'agent_connection' ? 'EXTERNAL_MANAGER_DELIVERY_REQUIRED'
          : row.managerKind === 'none' ? 'NO_MANAGER_ASSIGNED' : 'CANONICAL_AUTHORITY_UNAVAILABLE';
        await db.query(`update app.agent_jobs set unavailable_reason=$2, updated_at=now()
          where id=$1 and state='pending'`, [jobId, reason]);
        return null;
      }

      const runId: string = row.runId || deterministicWorkUuid(`run:${row.activityId}:1`);
      // inputDigest covers the canonical durable envelope available before provider body read;
      // body evidence is included separately in the legacy decision digest after read.
      const inputDigest = createHash('sha256').update(JSON.stringify({ messageId: row.messageId,
        providerMessageId: row.providerMessageId, sender: row.sender, subject: row.subject,
        receivedAt: new Date(row.receivedAt).toISOString(), attachments: attachmentMetadata(row.attachments) })).digest('hex');
      await db.query(`insert into app.agent_runs
        (id,activity_id,user_id,account_id,sequence,manager_kind,manager_lifecycle_revision,
         assignment_id,assignment_revision,grant_id,grant_revision,safety_revision,mode,trigger,input_digest,
         correlation_id,causation_id,state,created_at,started_at)
        values($1,$2,$3,$4,1,'mastra',null,$5,$6,$7,$8,$9,'automatic',
          jsonb_build_object('kind','arrival','messageId',$10::text),$11,'arrival:'||$2::uuid::text,$2::uuid,
          'running',now(),now()) on conflict(id) do nothing`,
      [runId,row.activityId,row.userId,row.accountId,row.assignmentId,row.assignmentRevision,row.grantId,
        row.grantRevision,row.safetyRevision,row.messageId,inputDigest]);
      await db.query(`update app.agent_jobs set state='running', agent_run_id=$2,
        unavailable_reason=null, attempt=case when state='pending' then attempt+1 else attempt end, updated_at=now()
        where id=$1 and (agent_run_id is null or agent_run_id=$2)`, [jobId, runId]);
      return { id: row.id, activityId: row.activityId, userId: row.userId, accountId: row.accountId,
        accountEmail: row.accountEmail, messageId: row.messageId, providerMessageId: row.providerMessageId,
        sender: row.sender, subject: row.subject, receivedAt: row.receivedAt,
        attachments: attachmentMetadata(row.attachments), attempt: row.jobState === 'pending' ? row.attempt + 1 : row.attempt,
        runId };
    });
  }
  async failAdapter(job: ClaimedAgentJob, code: string): Promise<void> {
    await this.db.transaction(async (db) => {
      await db.query(`update app.agent_jobs set state = 'failed', last_error_code = $2, updated_at = now() where id = $1`, [job.id, code]);
      await db.query(`update app.activities set state = 'failed', last_error_code = $2, updated_at = now() where id = $1`, [job.activityId, code]);
      if (job.runId) {
        await db.query(`update app.agent_runs set state='completed', outcome='failed', error_code=$2,
          completed_at=now() where id=$1 and state='running'`, [job.runId, code]);
        await db.query(`update app.agent_activities set state='attention_required',revision=revision+1,
          updated_at=now() where id=$1 and state='open'`, [job.activityId]);
      }
    });
  }
  async cacheBody(messageId: string, bodyText: string): Promise<void> {
    await this.db.query(`insert into app.message_bodies (message_id, text_body, purge_after) values ($1, $2, now() + make_interval(days => $3)) on conflict (message_id) do update set text_body = excluded.text_body, cached_at = now(), purge_after = excluded.purge_after`, [messageId, bodyText, this.bodyRetentionDays]);
  }
}

/** Reads provider content only after the durable job is claimed, then passes scoped text to triage. */
export class DeliverAgentConsumer implements AgentJobHandler<ClaimedAgentJob> {
  constructor(private readonly clients: { clientForUser(userId: string): { initialize(): Promise<unknown>; readMessage: HypermailReadClient['readMessage'] } }, private readonly triage: Pick<TriageService, 'triage'>, private readonly store: Pick<PostgresAgentJobStore, 'failAdapter' | 'cacheBody'>, private readonly globalConstraints: string, private readonly planner?: Pick<PostgresPolicyPlanner, 'plan'>) {}
  async evaluate(job: ClaimedAgentJob): Promise<void> {
    let bodyText: string;
    try {
      const client = this.clients.clientForUser(job.userId);
      await client.initialize();
      const message = await client.readMessage(job.accountEmail, job.providerMessageId, 'text');
      bodyText = message.body ?? '';
      // Caching is optional; a cache outage must not prevent a durable decision.
      await this.store.cacheBody(job.messageId, bodyText).catch(() => undefined);
    } catch (error) {
      await this.store.failAdapter(job, 'AGENT_INPUT_UNAVAILABLE');
      throw error;
    }
    const outcome = await this.triage.triage({ activityId: job.activityId, userId: job.userId, accountId: job.accountId, attempt: job.attempt,
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
      `select n.activity_id, ac.user_id, n.sender_label, n.subject, n.status_label
       from app.logical_notifications n
       join app.activities a on a.id = n.activity_id
       join app.accounts ac on ac.id = a.account_id
       where n.id = $1`, [notificationId],
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
  /** Legacy single-owner seam. Prefer createHypermailForUser for tenant isolation. */
  createHypermail?(environment: WorkerEnvironment): HypermailReadClient;
  createHypermailForUser?(environment: WorkerEnvironment, userId: string): HypermailReadClient;
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
  const tenantSessions = environment.HYPERMAIL_TENANT_ROUTES ? createTenantHypermailSessionProvider({
    routes: parseTenantHypermailRoutes(environment.HYPERMAIL_TENANT_ROUTES), configVersion: 'environment', protocolVersion: environment.HYPERMAIL_PROTOCOL_VERSION,
  }) : undefined;
  const client = tenantSessions ? undefined : factories.createHypermail
    ? factories.createHypermail(environment)
    : environment.NODE_ENV === 'development'
      ? new HypermailReadClient({ endpoint: environment.HYPERMAIL_URL, protocolVersion: environment.HYPERMAIL_PROTOCOL_VERSION, headers: { authorization: `Bearer ${environment.HYPERMAIL_KEY}` } })
      : undefined;
  if (!tenantSessions && !client && !factories.createHypermailForUser) throw new Error('HYPERMAIL_TENANT_ROUTES_REQUIRED');
  let tenantReadiness: Promise<void> | undefined;
  const ensureTenantReadiness = (): Promise<void> => tenantSessions
    ? (tenantReadiness ??= tenantSessions.checkReadiness())
    : Promise.reject(new Error('HYPERMAIL_TENANT_ROUTE_REQUIRED'));
  let hypermailInitialization: ReturnType<HypermailReadClient['initialize']> | undefined;
  const ensureHypermail = async (): Promise<unknown> => {
    if (!client) throw new Error('HYPERMAIL_TENANT_ROUTE_REQUIRED');
    hypermailInitialization ??= client.initialize(); return hypermailInitialization;
  };
  const initializedHypermail = client ? {
    initialize: ensureHypermail,
    readMessage: async (...input: Parameters<HypermailReadClient['readMessage']>) => { await ensureHypermail(); return client.readMessage(...input); },
    establishBaseline: async (...input: Parameters<HypermailReadClient['establishBaseline']>) => { await ensureHypermail(); return client.establishBaseline(...input); },
    pollNewInbox: async (...input: Parameters<HypermailReadClient['pollNewInbox']>) => { await ensureHypermail(); return client.pollNewInbox(...input); },
    inbox: async (...input: Parameters<HypermailReadClient['inbox']>) => { await ensureHypermail(); return client.inbox(...input); },
  } : undefined;
  const createHypermailForUser = factories.createHypermailForUser?.bind(factories);
  const rawTenantHypermail = tenantSessions ? null : createHypermailForUser
    ? new TenantHypermailClientCache((userId) => createHypermailForUser(environment, userId))
    : new SingleOwnerTenantClient(initializedHypermail as NonNullable<typeof initializedHypermail>);
  const tenantHypermail = new TenantHypermailClientCache((userId) => {
    if (tenantSessions) {
      const usingRead = <Result>(operation: (read: HypermailReadClient) => Promise<Result>): Promise<Result> =>
        tenantSessions.withSessionForUser(userId, bundle => operation(bundle.read));
      return {
        initialize: async () => { await usingRead(() => Promise.resolve(undefined)); },
        readMessage: (...input: Parameters<HypermailReadClient['readMessage']>) => usingRead(read => read.readMessage(...input)),
        establishBaseline: (...input: Parameters<HypermailReadClient['establishBaseline']>) => usingRead(read => read.establishBaseline(...input)),
        pollNewInbox: (...input: Parameters<HypermailReadClient['pollNewInbox']>) => usingRead(read => read.pollNewInbox(...input)),
        inbox: (...input: Parameters<HypermailReadClient['inbox']>) => usingRead(read => read.inbox(...input)),
      };
    }
    if (!rawTenantHypermail) throw new Error('HYPERMAIL_TENANT_ROUTE_REQUIRED');
    const scoped = rawTenantHypermail.clientForUser(userId);
    let initialization: Promise<unknown> | undefined;
    const initialize = (): Promise<unknown> => { initialization ??= scoped.initialize(); return initialization; };
    return { initialize,
      readMessage: async (...input: Parameters<HypermailReadClient['readMessage']>) => { await initialize(); return scoped.readMessage(...input); },
      establishBaseline: async (...input: Parameters<HypermailReadClient['establishBaseline']>) => { await initialize(); return scoped.establishBaseline(...input); },
      pollNewInbox: async (...input: Parameters<HypermailReadClient['pollNewInbox']>) => { await initialize(); return scoped.pollNewInbox(...input); },
      inbox: async (...input: Parameters<HypermailReadClient['inbox']>) => { await initialize(); return scoped.inbox(...input); },
    };
  });
  const boss = new PgBossRuntime(rawBoss);
  const sql = workerSql(database);
  const operationalGuard=new PostgresOperationalGuard(sql,{tasksPerMinute:environment.USER_TASK_RATE_PER_MINUTE,claimsPerMinute:environment.USER_TASK_RATE_PER_MINUTE,concurrentTasks:environment.USER_TASK_CONCURRENCY,pendingTasks:environment.USER_PENDING_TASK_QUOTA},environment.PUSH_SUBSCRIPTION_ENCRYPTION_KEY);
  const ingestionStore = new PostgresIngestionStore(sql);
  const dispatchRecovery = new DispatchRecovery(ingestionStore, new PgBossDeliveryQueue(rawBoss));
  const holderId = (factories.holderId ?? defaultHolderId)();
  const ingestion = new LeaseScheduler(new IngestionWorker(ingestionStore, new HypermailInboxProvider(tenantHypermail), dispatchRecovery, clock), ingestionStore, clock, holderId, environment.POLL_INTERVAL_SECONDS * 1000);
  const lifecycleStore = new PostgresLifecycleStore(sql);
  const lifecycle = new LifecycleScheduler(new LifecycleWorker(lifecycleStore, clock, {
    bodyRetentionDays: environment.BODY_RETENTION_DAYS,
    oauthRetentionHours: environment.OAUTH_RETENTION_HOURS,
    sessionRetentionDays: environment.SESSION_RETENTION_DAYS,
    taskPayloadRetentionDays: environment.TASK_PAYLOAD_RETENTION_DAYS,
    operationalTextRetentionDays: environment.OPERATIONAL_TEXT_RETENTION_DAYS,
    lifecycleBatchSize: environment.LIFECYCLE_BATCH_SIZE,
  }), lifecycleStore, clock, holderId, environment.LIFECYCLE_INTERVAL_SECONDS * 1000);
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
  const legacyPolicyMcp = (client as unknown as { transport?: Pick<HypermailMcpHttpClient, 'call'> } | undefined)?.transport;
  const legacyPolicyExecutor = client ? createPolicyExecutor(database, new HypermailPrivateMutationTransport(database, legacyPolicyMcp, ensureHypermail), environment.INCORRECT_MUTATION_THRESHOLD) : undefined;
  const policyRecovery = new DurablePolicyRecovery(database, policyDispatcher);
  const policyPlanner = new PostgresPolicyPlanner(database, policyDispatcher);
  const agentStore = new PostgresAgentJobStore(database, environment.BODY_RETENTION_DAYS);
  const agentConsumer = new ClaimingAgentConsumer(agentStore, new DeliverAgentConsumer(tenantHypermail, triage, agentStore, environment.AGENT_GLOBAL_CONSTRAINTS, policyPlanner));
  const notificationPersistence = new PostgresNotificationPersistence(database, new PushSubscriptionAesCodec(environment.PUSH_SUBSCRIPTION_ENCRYPTION_KEY));
  const notificationTransport = (factories.createNotificationTransport ?? ((env: WorkerEnvironment) => new WebPushVapidTransport({ subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY })))(environment);
  const notificationWorker = new NotificationWorker(notificationPersistence, notificationTransport);
  const notificationConsumer = new DeliverNotificationConsumer(new PostgresNotificationInputStore(database), notificationWorker);
  const policyConsumer = new DeliverPolicyConsumer(new PostgresPolicyActionInputStore(database), tenantSessions ? async (userId) => {
    const lease = await tenantSessions.leaseForUser(userId);
    const transport = new HypermailPrivateMutationTransport(database, lease.bundle.read.transport, () => Promise.resolve());
    return { executor: createPolicyExecutor(database, transport, environment.INCORRECT_MUTATION_THRESHOLD), release: () => lease.release() };
  } : legacyPolicyExecutor as NonNullable<typeof legacyPolicyExecutor>);
  const agentTaskRecovery = new AgentTaskRecovery(new AgentTaskStore(database,operationalGuard));
  const dependencies: WorkerRuntimeDependencies = {
    boss, ingestion, lifecycle, agentTaskRecovery, dispatchRecovery: { recover: () => dispatchRecovery.dispatch() }, notificationRecovery, policyRecovery,
    agentConsumer, notificationConsumer, policyConsumer,
    closeDatabase: async () => { await closeAgentResources(); await tenantSessions?.close(); await database.close(); },
    probes: {
      database: async () => { await database.query('select 1'); return true; },
      hypermail: async () => { if (tenantSessions) { await ensureTenantReadiness(); return true; } await ensureHypermail(); return true; },
      // Readiness initializes every configured tenant and validates the restricted policy tool contract without mutation I/O.
      model: () => Promise.resolve(true),
      notifications: () => Promise.resolve(true),
      // Validate the pinned runtime's advertised restricted mutation schemas without provider mutation I/O.
      policy: async () => { if (tenantSessions) { await ensureTenantReadiness(); return true; } const legacyClient=client; if(!legacyClient)throw new Error('HYPERMAIL_TENANT_ROUTE_REQUIRED'); await ensureHypermail(); await legacyClient.verifyPolicyContract(); return true; },
    },
  };
  return new WorkerRuntime(environment, dependencies);
}
