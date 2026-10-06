import { createHash } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import postgres, { type Sql } from 'postgres';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { MailboxMemoryUnavailableError, MastraSourceHistory, PostgresDecisionPersistence, TriageService, createMastraPostgresStorage, mastraConversationModel, mastraDecisionModel, type ConversationModel, type DecisionModel, type MailboxMemory, type SourceHistory, type TriageInput } from '@hypermail/agent';
import { RecoveryMailIdentity } from '@hypermail/auth';
import { workerEnvSchema } from '@hypermail/contracts';
import { AgentTaskStore, ConversationStore, PostgresMailboxMemoryEventStore, createPostgresClient, type MailboxMemoryTimingPolicy, type ManagedSqlClient } from '@hypermail/db';
import { HypermailReadClient, createTenantHypermailSessionProvider, parseTenantHypermailRoutes, SingleOwnerTenantClient, TenantHypermailClientCache, type HypermailMcpHttpClient, type Folder } from '@hypermail/hypermail';
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
import { createHindsightMailboxMemory, hindsightConfigurationFromWorkerEnvironment, ReadinessGatedMailboxMemory } from './hindsight-memory.js';
import { MailboxCurrentEmailRetainer, MailboxMemoryEventDeliveryWorker, MailboxMemoryEventScheduler, PostgresMailboxMemoryMessageHydrator, type CurrentEmailMemoryRetainer } from './mailbox-memory-delivery.js';
import { ClaimingAgentConsumer, DurableNotificationRecovery, type AgentJobHandler, type AgentJobStore, type BossJob, type BossRuntime, type JobConsumer, type NotificationDispatcher, type QueueName, type WorkerEnvironment, type WorkerRuntimeDependencies, WorkerRuntime, defaultHolderId } from './runtime.js';
import { DeliverConversationConsumer, DurableConversationRecovery } from './conversations.js';
import { MailboxOwnerMemoryInputs } from './mailbox-memory-inputs.js';
import { PostgresNotificationDispatchStore } from './notification-dispatch-store.js';

/** pg-boss invokes a worker with a batch, while WorkerRuntime deliberately consumes one job. */
type PgBossClient = PgBossLike & {
  start(): Promise<unknown>;
  createQueue(name: string): Promise<unknown>;
  stop(options?: { graceful?: boolean; timeout?: number }): Promise<void>;
  work(name: string, handler: (jobs: readonly BossJob[]) => Promise<void>): Promise<unknown>;
};

export class PgBossRuntime implements BossRuntime {
  constructor(private readonly boss: PgBossClient) {}
  async start(): Promise<void> { await this.boss.start(); }
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
  providerMessageId: string; sender: string; subject: string; receivedAt: string | Date; currentUserInstruction?: string;
  attachments: { sourceId: string; providerAttachmentId: string; filename: string; mediaType: string; sizeBytes: number }[]; attempt: number; runId?: string;
}>;

type AgentJobRow = Omit<ClaimedAgentJob, 'attachments'> & { attachments: unknown };
const isAttachmentMetadata = (value: unknown): value is ClaimedAgentJob['attachments'][number] => {
  if (value === null || typeof value !== 'object') return false;
  const attachment = value as Record<string, unknown>;
  const sourceId = attachment['sourceId'];
  const providerAttachmentId = attachment['providerAttachmentId'];
  const filename = attachment['filename'];
  const mediaType = attachment['mediaType'];
  const sizeBytes = attachment['sizeBytes'];
  return typeof sourceId === 'string' && typeof providerAttachmentId === 'string'
    && typeof filename === 'string' && typeof mediaType === 'string' && typeof sizeBytes === 'number' && Number.isInteger(sizeBytes) && sizeBytes >= 0;
};
const attachmentMetadata = (value: unknown): ClaimedAgentJob['attachments'] => Array.isArray(value) ? value.filter(isAttachmentMetadata) : [];

function deterministicWorkUuid(seed: string): string {
  const hex=createHash('sha256').update(seed).digest('hex');
  const variant = ['8', '9', 'a', 'b'][Number.parseInt(hex.charAt(16), 16) & 3] ?? '8';
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class PostgresAgentJobStore implements AgentJobStore<ClaimedAgentJob> {
  constructor(private readonly db: ManagedSqlClient, private readonly bodyRetentionDays: number, private readonly memoryTiming: MailboxMemoryTimingPolicy) {}
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
          m.received_at as "receivedAt", qi.answer as "currentUserInstruction", coalesce(jsonb_agg(jsonb_build_object(
            'sourceId',att.id,'providerAttachmentId',att.provider_attachment_id,
            'filename',att.filename,'mediaType',att.media_type,'sizeBytes',att.size_bytes))
            filter(where att.id is not null),'[]'::jsonb) as attachments, j.attempt,
          ma.id as "assignmentId", ma.revision as "assignmentRevision", ma.manager_kind as "managerKind",
          ma.automatic_processing_enabled as "automaticEnabled", g.id as "grantId", g.revision as "grantRevision",
          g.state as "grantState", g.invocation_modes as "grantModes", g.capabilities as "grantCapabilities",
          s.revision as "safetyRevision", s.invocation_modes as "safetyModes", s.capabilities as "safetyCapabilities"
        from locked_job locked join app.agent_jobs j on j.id=locked.id join app.activities a on a.id=j.activity_id
        join app.accounts ac on ac.id=a.account_id join app.messages m on m.id=a.message_id
        left join app.attachments att on att.message_id=m.id
        left join lateral (select q.answer from app.questions q where q.activity_id=a.id and q.state='answered'
          order by q.answered_at desc nulls last limit 1) qi on true
        left join app.mailbox_manager_assignments ma on ma.user_id=ac.user_id and ma.account_id=a.account_id
        left join app.agent_capability_grants g on g.user_id=ac.user_id and g.account_id=a.account_id
          and g.manager_kind=ma.manager_kind and g.agent_connection_id is not distinct from ma.agent_connection_id
        left join app.agent_safety_ceiling s on s.singleton=true
        where j.id=$1::uuid and ($2::uuid is null or ac.user_id=$2::uuid) and ac.state in ('ready','degraded') and j.available_at<=now()
          and j.state IN ('pending', 'running')
        group by j.id,j.activity_id,j.state,j.agent_run_id,ac.user_id,a.account_id,ac.email,m.id,
          m.provider_message_id,m.sender,m.subject,m.received_at,qi.answer,j.attempt,ma.id,ma.revision,
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
        unavailable_reason=null, last_error_code=null, attempt=case when state='pending' then attempt+1 else attempt end, updated_at=now()
        where id=$1 and (agent_run_id is null or agent_run_id=$2)`, [jobId, runId]);
      return { id: row.id, activityId: row.activityId, userId: row.userId, accountId: row.accountId,
        accountEmail: row.accountEmail, messageId: row.messageId, providerMessageId: row.providerMessageId,
        sender: row.sender, subject: row.subject, receivedAt: row.receivedAt,
        ...(row.currentUserInstruction ? { currentUserInstruction: row.currentUserInstruction } : {}), attachments: attachmentMetadata(row.attachments), attempt: row.jobState === 'pending' ? row.attempt + 1 : row.attempt,
        runId };
    });
  }
  async memoryContextCutoff(job: ClaimedAgentJob): Promise<Date> {
    if (!job.runId) throw new MailboxMemoryUnavailableError();
    const result = await this.db.query<{ startedAt: Date | string }>(`select started_at as "startedAt" from app.agent_runs
      where id=$1::uuid and user_id=$2::uuid and account_id=$3::uuid`, [job.runId, job.userId, job.accountId]);
    const value = result.rows[0]?.startedAt;
    if (!value) throw new MailboxMemoryUnavailableError();
    const cutoff = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(cutoff.getTime())) throw new MailboxMemoryUnavailableError();
    return cutoff;
  }
  async deferMemory(job: ClaimedAgentJob): Promise<void> {
    const deferred = await this.db.query<{ id: string }>(`update app.agent_jobs set state='pending', queue_job_id=null,
      available_at=now()+make_interval(secs => least($4, $3 * power(2, least(greatest(attempt-1,0), 30))::integer)),
      last_error_code='MAILBOX_MEMORY_UNAVAILABLE', unavailable_reason='MAILBOX_MEMORY_UNAVAILABLE', updated_at=now()
      where id=$1 and state='running' and ($2::uuid is null or agent_run_id=$2::uuid) returning id`, [job.id, job.runId ?? null, this.memoryTiming.retryBaseDelaySeconds, this.memoryTiming.retryMaximumDelaySeconds]);
    if (deferred.rows.length !== 1) throw new Error('MAILBOX_MEMORY_DEFER_FAILED');
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
  async contextualInputs(job: ClaimedAgentJob, providerFolders: readonly Folder[]): Promise<Pick<TriageInput, 'availableFolders' | 'availableDrafts'>> {
    return this.db.transaction(async db => {
      const availableFolders: TriageInput['availableFolders'] = [];
      for (const folder of providerFolders) {
        const result = await db.query<{ id: string }>(`insert into app.folders(account_id,provider_folder_id,name,role,parent_provider_folder_id)
          select ac.id,$3,$4,$5,$6 from app.accounts ac where ac.id=$1 and ac.user_id=$2
          on conflict(account_id,provider_folder_id) do update set name=excluded.name,role=excluded.role,
            parent_provider_folder_id=excluded.parent_provider_folder_id,updated_at=now() returning id`,
        [job.accountId, job.userId, folder.id, folder.displayName, folder.wellKnownName ?? null, folder.parentFolderId ?? null]);
        const row = result.rows[0];
        if (!row) throw new Error('AGENT_FOLDER_SCOPE_INVALID');
        availableFolders.push({ id: row.id, displayName: folder.displayName, ...(folder.wellKnownName ? { wellKnownName: folder.wellKnownName } : {}) });
      }
      const drafts = await db.query<TriageInput['availableDrafts'][number]>(`select d.id,d.version,d.recipients,d.subject,d.body,d.body_format as "bodyFormat"
        from app.drafts d join app.accounts ac on ac.id=d.account_id
        where d.account_id=$1 and ac.user_id=$2 and d.source_message_id=$3 and d.state in ('editing','failed')
        order by d.updated_at desc,d.id limit 20`, [job.accountId, job.userId, job.messageId]);
      return { availableFolders, availableDrafts: [...drafts.rows] };
    });
  }
  async excludeRecoveryMail(job: ClaimedAgentJob): Promise<void> {
    await this.db.transaction(async db => {
      await db.query('select id from app.agent_activities where id=$1::uuid for update', [job.activityId]);
      const completed = await db.query(`update app.agent_jobs set state='succeeded',last_error_code=null,
        unavailable_reason='RECOVERY_MAIL_EXCLUDED',updated_at=now()
        where id=$1::uuid and state='running' and agent_run_id=$2::uuid returning id`, [job.id, job.runId]);
      if (!completed.rows.length) return;
      await db.query(`update app.agent_runs set state='completed',outcome='no_action',error_code=null,completed_at=now()
        where id=$1::uuid and state='running'`, [job.runId]);
      await db.query(`update app.activities set state='handled',last_error_code=null,updated_at=now() where id=$1::uuid`, [job.activityId]);
      await db.query(`update app.agent_activities set state='resolved',revision=revision+1,updated_at=now() where id=$1::uuid and state='open'`, [job.activityId]);
      await db.query(`insert into app.agent_activity_events(activity_id,user_id,account_id,sequence,correlation_id,causation_id,detail,occurred_at)
        select $1::uuid,$2::uuid,$3::uuid,coalesce(max(sequence),0)+1,'recovery-exclusion:'||$1::uuid::text,$4::uuid,
        jsonb_build_object('type','run_completed','runId',$4::uuid,'outcome','no_action'),now()
        from app.agent_activity_events where activity_id=$1::uuid`, [job.activityId, job.userId, job.accountId, job.runId]);
      await db.query(`insert into app.audits(actor_type,actor_id,account_id,activity_id,event,correlation_id,metadata)
        values('system',$1::uuid,$2::uuid,$3::uuid,'recovery_mail.excluded','recovery-exclusion:'||$3::uuid::text,'{}'::jsonb)`,
      [job.userId, job.accountId, job.activityId]);
    });
  }
  async cacheBody(messageId: string, bodyText: string): Promise<void> {
    await this.db.query(`insert into app.message_bodies (message_id, text_body, purge_after) values ($1, $2, now() + make_interval(days => $3)) on conflict (message_id) do update set text_body = excluded.text_body, cached_at = now(), purge_after = excluded.purge_after`, [messageId, bodyText, this.bodyRetentionDays]);
  }
}

/** Reads provider content only after the durable job is claimed, then passes scoped text to triage. */
export class DeliverAgentConsumer implements AgentJobHandler<ClaimedAgentJob> {
  constructor(private readonly clients: { clientForUser(userId: string): Readonly<{ initialize(): Promise<unknown>; readMessage: HypermailReadClient['readMessage']; folders: HypermailReadClient['folders']; openAttachment?: HypermailReadClient['openAttachment'] }> }, private readonly triage: Pick<TriageService, 'triage'> & Partial<Pick<TriageService, 'rememberUserInstruction'>>, private readonly store: Pick<PostgresAgentJobStore, 'deferMemory' | 'failAdapter' | 'cacheBody' | 'contextualInputs' | 'memoryContextCutoff' | 'excludeRecoveryMail'>, private readonly ownerInputs: Pick<MailboxOwnerMemoryInputs, 'prepare'>, private readonly globalConstraints: string, private readonly planner?: Pick<PostgresPolicyPlanner, 'plan'>, private readonly currentEmailRetainer?: CurrentEmailMemoryRetainer, private readonly recoveryIdentity?: Pick<RecoveryMailIdentity, 'isRecoveryMail'>) {}
  async evaluate(job: ClaimedAgentJob): Promise<void> {
    let bodyText: string;
    let message: Awaited<ReturnType<HypermailReadClient['readMessage']>>;
    let context: Pick<TriageInput, 'availableFolders' | 'availableDrafts'>;
    const client = this.clients.clientForUser(job.userId);
    try {
      await client.initialize();
      message = await client.readMessage(job.accountEmail, job.providerMessageId, 'text');
      bodyText = message.body ?? '';
      if (await this.recoveryIdentity?.isRecoveryMail({ userId: job.userId, internetMessageId: message.internetMessageId ?? null, body: bodyText })) {
        await this.store.excludeRecoveryMail(job);
        return;
      }
      context = await this.store.contextualInputs(job, await client.folders(job.accountEmail));
      // Caching is optional; a cache outage must not prevent a durable decision.
      await this.store.cacheBody(job.messageId, bodyText).catch(() => undefined);
    } catch (error) {
      await this.store.failAdapter(job, 'AGENT_INPUT_UNAVAILABLE');
      throw error;
    }
    try {
      await this.ownerInputs.prepare({ userId: job.userId, accountId: job.accountId, acceptedBefore: await this.store.memoryContextCutoff(job) });
    } catch {
      await this.store.deferMemory(job);
      return;
    }
    // Finish the richer provider projection and supported files before mandatory recall.
    if (this.currentEmailRetainer) {
      try {
        if (!client.openAttachment) throw new Error('HYPERMAIL_ATTACHMENT_INTERFACE_UNAVAILABLE');
        await this.currentEmailRetainer.retainCurrentEmail({ scope: { userId: job.userId, mailboxId: job.accountId },
          canonicalMessageId: job.messageId, providerMessageId: job.providerMessageId,
          accountEmail: job.accountEmail, receivedAt: new Date(job.receivedAt).toISOString(), message,
          attachments: job.attachments, client: { openAttachment: client.openAttachment.bind(client) } });
      } catch {
        await this.store.deferMemory(job);
        return;
      }
    }
    let outcome: Awaited<ReturnType<TriageService['triage']>>;
    try {
      if (job.currentUserInstruction) await this.triage.rememberUserInstruction?.({ userId: job.userId,
        accountId: job.accountId, activityId: job.activityId, instruction: job.currentUserInstruction });
      outcome = await this.triage.triage({ activityId: job.activityId, userId: job.userId, accountId: job.accountId, attempt: job.attempt, ...(job.runId ? { runId: job.runId } : {}), ...context,
        email: { messageId: job.messageId, from: job.sender, subject: job.subject, receivedAt: new Date(job.receivedAt).toISOString(), bodyText,
          attachments: job.attachments.map(({ filename, mediaType, sizeBytes }) => ({ filename, mediaType, sizeBytes })) },
        ...(job.currentUserInstruction ? { currentUserInstruction: job.currentUserInstruction } : {}),
        globalConstraints: this.globalConstraints }, { currentEmailRetained: this.currentEmailRetainer !== undefined });
    } catch (error) {
      if (!(error instanceof MailboxMemoryUnavailableError)) throw error;
      // Completing this queue delivery after the durable row is reset avoids spending pg-boss
      // retries. DispatchRecovery will offer the same logical job after the bounded backoff.
      await this.store.deferMemory(job);
      return;
    }
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
  createBoss?(url: string): PgBossClient;
  /** Legacy single-owner seam. Prefer createHypermailForUser for tenant isolation. */
  createHypermail?(environment: WorkerEnvironment): HypermailReadClient;
  createHypermailForUser?(environment: WorkerEnvironment, userId: string): HypermailReadClient;
  createNotificationTransport?(environment: WorkerEnvironment): VapidPushTransport;
  /** Test seam: avoids creating provider and Mastra/Postgres clients. */
  createTriageService?(environment: WorkerEnvironment): Pick<TriageService, 'triage'>;
  /** Test-only model seam; retains real triage validation, persistence and policy. */
  createDecisionModel?(environment: WorkerEnvironment): DecisionModel;
  createConversationModel?(environment: WorkerEnvironment): ConversationModel;
  createSourceHistory?(environment: WorkerEnvironment): SourceHistory;
  /** Test seam for the required SDK-neutral memory port. Native production uses Hindsight. */
  createMailboxMemory?(): MailboxMemory;
  holderId?(): string;
}

/** Production composition: policy writes are constrained to the private transport below. */
export function composeWorkerRuntime(environment: WorkerEnvironment, factories: ProductionFactories = {}): WorkerRuntime {
  // Keep the shared schema as the source of truth even for direct composition callers.
  workerEnvSchema.parse(environment);
  const database = (factories.createDatabase ?? createPostgresClient)(environment.DATABASE_URL);
  const rawBoss = (factories.createBoss ?? ((url: string) => new PgBoss({ connectionString: url })))(environment.DATABASE_URL);
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
    folders: async (...input: Parameters<HypermailReadClient['folders']>) => { await ensureHypermail(); return client.folders(...input); },
    openAttachment: async (...input: Parameters<HypermailReadClient['openAttachment']>) => { await ensureHypermail(); return client.openAttachment(...input); },
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
        folders: (...input: Parameters<HypermailReadClient['folders']>) => usingRead(read => read.folders(...input)),
        openAttachment: (...input: Parameters<HypermailReadClient['openAttachment']>) => usingRead(read => read.openAttachment(...input)),
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
      folders: async (...input: Parameters<HypermailReadClient['folders']>) => { await initialize(); return scoped.folders(...input); },
      openAttachment: async (...input: Parameters<HypermailReadClient['openAttachment']>) => { await initialize(); return scoped.openAttachment(...input); },
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
  // Every native model shares the configured private memory backend; injected ports are test seams.
  const configuredMailboxMemory = factories.createMailboxMemory?.()
    ?? (!factories.createTriageService || !factories.createConversationModel ? createHindsightMailboxMemory(hindsightConfigurationFromWorkerEnvironment(environment)) : undefined);
  const mailboxMemory = configuredMailboxMemory ? new ReadinessGatedMailboxMemory(configuredMailboxMemory) : undefined;
  const needsNativeMemory = (!factories.createTriageService && !factories.createDecisionModel) || !factories.createConversationModel || !factories.createSourceHistory;
  const storage = needsNativeMemory ? createMastraPostgresStorage(environment.DATABASE_URL) : undefined;
  const model = needsNativeMemory ? createModel(environment) : undefined;
  const memory = storage && model ? new Memory({ storage, options: { observationalMemory: { enabled: true, scope: 'resource', model } } }) : undefined;
  const sourceHistory = factories.createSourceHistory?.(environment) ?? (memory ? new MastraSourceHistory(memory) : undefined);
  if (!sourceHistory) throw new Error('SOURCE_HISTORY_REQUIRED');
  const recoveryIdentity = new RecoveryMailIdentity(database);
  let decisionSql: Sql | undefined;
  let triage: Pick<TriageService, 'triage'> & Partial<Pick<TriageService, 'rememberUserInstruction'>>;
  if (factories.createTriageService) triage = factories.createTriageService(environment);
  else {
    const decisionModel = factories.createDecisionModel?.(environment)
      ?? (memory && model ? mastraDecisionModel(new Agent({ id: 'hypermail-triage', name: 'hypermail-triage', instructions: 'Produce structured triage decisions only.', model, memory })) : undefined);
    if (!mailboxMemory || !decisionModel) throw new Error('HINDSIGHT_MEMORY_REQUIRED');
    decisionSql = postgres(environment.DATABASE_URL);
    triage = new TriageService({ model: decisionModel, persistence: new PostgresDecisionPersistence(decisionSql, environment.ACTION_CONFIDENCE_THRESHOLD), mailboxMemory,
      sourceHistory, modelProvider: environment.MODEL_PROVIDER, modelName: environment.MODEL_NAME });
  }
  let conversationModel: ConversationModel;
  if (factories.createConversationModel) conversationModel = factories.createConversationModel(environment);
  else {
    if (!memory || !model) throw new Error('CONVERSATION_MEMORY_REQUIRED');
    const agent = new Agent({ id: 'hypermail-conversation', name: 'hypermail-conversation', instructions: 'Read-only scoped conversation. No mailbox mutation tools.', model, memory, maxRetries: 0 });
    conversationModel = mastraConversationModel(agent);
  }
  const closeAgentResources = async (): Promise<void> => {
    await Promise.allSettled([decisionSql?.end({ timeout: 5 }), storage?.close()]);
  };
  const conversationStore = new ConversationStore(database);
  const ownerInputs = new MailboxOwnerMemoryInputs(conversationStore, sourceHistory);
  const conversationConsumer = new DeliverConversationConsumer(conversationStore, conversationModel, ownerInputs, mailboxMemory, async (userId, accountId, messageId) => {
    const result = await database.query<{ accountEmail: string; providerMessageId: string; sender: string; subject: string }>(`select ac.email as "accountEmail",m.provider_message_id as "providerMessageId",
      coalesce(m.sender->>'name',m.sender->>'address','') as sender,coalesce(m.subject,'') as subject
      from app.messages m join app.accounts ac on ac.id=m.account_id
      join app.user_accounts ua on ua.account_id=ac.id and ua.user_id=ac.user_id
      where m.id=$1::uuid and ac.id=$2::uuid and ua.user_id=$3::uuid`, [messageId, accountId, userId]);
    const row = result.rows[0];
    if (!row) throw new Error('CONVERSATION_CONTEXT_INVALID');
    const client = tenantHypermail.clientForUser(userId);
    await client.initialize();
    const message = await client.readMessage(row.accountEmail, row.providerMessageId, 'text');
    if (await recoveryIdentity.isRecoveryMail({ userId, internetMessageId: message.internetMessageId ?? null, body: message.body ?? '' })) throw new Error('CONVERSATION_CONTEXT_RECOVERY_MAIL');
    if (message.id !== row.providerMessageId) throw new Error('CONVERSATION_CONTEXT_INVALID');
    return { messageId, sender: row.sender, subject: row.subject, body: message.body ?? '' };
  });
  const conversationRecovery = new DurableConversationRecovery(conversationStore, {
    enqueue: async (turnId, userId) => {
      // An existing singleton means another delivery already owns publication; SQL remains authoritative.
      await rawBoss.send('conversation.respond', { turnId, userId }, { singletonKey: `conversation:${turnId}` });
    },
  });
  const policyDispatcher = new PgBossPolicyDispatcher(rawBoss);
  const legacyPolicyMcp = (client as unknown as { transport?: Pick<HypermailMcpHttpClient, 'call'> } | undefined)?.transport;
  const legacyPolicyExecutor = client ? createPolicyExecutor(database, new HypermailPrivateMutationTransport(database, legacyPolicyMcp, ensureHypermail), environment.INCORRECT_MUTATION_THRESHOLD) : undefined;
  const policyRecovery = new DurablePolicyRecovery(database, policyDispatcher, 100, environment.ACTION_CONFIDENCE_THRESHOLD);
  const policyPlanner = new PostgresPolicyPlanner(database, policyDispatcher, environment.ACTION_CONFIDENCE_THRESHOLD);
  const memoryTiming: MailboxMemoryTimingPolicy = {
    retryBaseDelaySeconds: environment.MAILBOX_MEMORY_RETRY_BASE_DELAY_SECONDS,
    retryMaximumDelaySeconds: environment.MAILBOX_MEMORY_RETRY_MAXIMUM_DELAY_SECONDS,
    claimLeaseSeconds: environment.MAILBOX_MEMORY_CLAIM_LEASE_SECONDS,
    schedulerIntervalSeconds: environment.MAILBOX_MEMORY_SCHEDULER_INTERVAL_SECONDS,
  };
  const agentStore = new PostgresAgentJobStore(database, environment.BODY_RETENTION_DAYS, memoryTiming);
  const nativeEmailRetainer = mailboxMemory ? new MailboxCurrentEmailRetainer(mailboxMemory, {
    tempDirectory: environment.ATTACHMENT_TEMP_DIRECTORY, maxBytes: environment.HINDSIGHT_MAX_FILE_BYTES,
    operationTimeoutMs: environment.HINDSIGHT_REQUEST_TIMEOUT_MS }) : undefined;
  const currentEmailRetainer = nativeEmailRetainer ? {
    async retainCurrentEmail(input: Parameters<CurrentEmailMemoryRetainer['retainCurrentEmail']>[0]) {
      if (await recoveryIdentity.isRecoveryMail({ userId: input.scope.userId, internetMessageId: input.message.internetMessageId ?? null, body: input.message.body ?? '' })) return { attachmentsRetained: 0, attachmentsSkipped: [] };
      return nativeEmailRetainer.retainCurrentEmail(input);
    },
    retainGenericEvent: nativeEmailRetainer.retainGenericEvent.bind(nativeEmailRetainer),
  } : undefined;
  const agentConsumer = new ClaimingAgentConsumer(agentStore, new DeliverAgentConsumer(tenantHypermail, triage, agentStore,
    ownerInputs, environment.AGENT_GLOBAL_CONSTRAINTS, policyPlanner, currentEmailRetainer, recoveryIdentity));
  const memoryEventStore = new PostgresMailboxMemoryEventStore(database, memoryTiming);
  const memoryEvents = currentEmailRetainer ? new MailboxMemoryEventScheduler(
    new MailboxMemoryEventDeliveryWorker(memoryEventStore, new PostgresMailboxMemoryMessageHydrator(database),
      tenantHypermail, currentEmailRetainer, `${holderId}:mailbox-memory`, memoryTiming), memoryEventStore, clock, memoryTiming) : undefined;
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
    boss, ingestion, lifecycle, ...(memoryEvents ? { mailboxMemoryEvents: memoryEvents } : {}), agentTaskRecovery,
    dispatchRecovery: { recover: () => dispatchRecovery.dispatch() }, notificationRecovery, policyRecovery,
    agentConsumer, notificationConsumer, policyConsumer,
    conversationConsumer, conversationRecovery: { recover: () => conversationRecovery.tick() },
    closeDatabase: async () => { await closeAgentResources(); await tenantSessions?.close(); await database.close(); },
    probes: {
      database: async () => { await database.query('select 1'); return true; },
      hypermail: async () => { if (tenantSessions) { await ensureTenantReadiness(); return true; } await ensureHypermail(); return true; },
      hindsight: async () => { if (!mailboxMemory) return true; await mailboxMemory.readiness(); return true; },
      // Readiness initializes every configured tenant and validates the restricted policy tool contract without mutation I/O.
      model: () => Promise.resolve(true),
      notifications: () => Promise.resolve(true),
      // Validate the pinned runtime's advertised restricted mutation schemas without provider mutation I/O.
      policy: async () => { if (tenantSessions) { await ensureTenantReadiness(); return true; } const legacyClient=client; if(!legacyClient)throw new Error('HYPERMAIL_TENANT_ROUTE_REQUIRED'); await ensureHypermail(); await legacyClient.verifyPolicyContract(); return true; },
    },
  };
  return new WorkerRuntime(environment, dependencies);
}
