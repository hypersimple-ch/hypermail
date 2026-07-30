import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const app = pgSchema('app');
export const mastra = pgSchema('mastra');
export const queue = pgSchema('pgboss');

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const provider = app.enum('provider', ['microsoft', 'gmail', 'imap']);
export const accountState = app.enum('account_state', ['pending', 'ready', 'degraded', 'disabled']);
export const activityState = app.enum('activity_state', ['new', 'waiting_question', 'failed', 'handled', 'acknowledged']);
export const questionState = app.enum('question_state', ['open', 'answered', 'cancelled']);
export const decisionState = app.enum('decision_state', ['pending', 'question', 'actionable', 'no_action', 'failed']);
export const actionKind = app.enum('action_kind', [
  'archive',
  'recoverable_trash',
  'move',
  'mark_read',
  'mark_unread',
  'draft_create',
  'draft_edit',
]);
export const actionState = app.enum('action_state', ['planned', 'executing', 'succeeded', 'failed', 'unverifiable', 'incorrect']);
export const verificationState = app.enum('verification_state', ['pending', 'verified', 'failed', 'unverifiable']);
export const draftState = app.enum('draft_state', ['editing', 'ready', 'sending', 'sent', 'failed', 'discarded']);
export const sendApprovalState = app.enum('send_approval_state', ['pending', 'consumed', 'expired', 'cancelled']);
export const notificationState = app.enum('notification_state', ['pending', 'delivering', 'delivered', 'failed', 'suppressed']);
export const deliveryState = app.enum('delivery_state', ['pending', 'succeeded', 'retryable', 'permanent_failure']);
export const jobState = app.enum('job_state', ['pending', 'running', 'suspended', 'succeeded', 'failed', 'cancelled']);
export const healthState = app.enum('health_state', ['healthy', 'degraded', 'failed', 'paused']);

export const users = app.table('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt,
  updatedAt,
}, (table) => [uniqueIndex('users_email_unique').on(table.email)]);

export const sessions = app.table('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt,
}, (table) => [
  uniqueIndex('sessions_token_hash_unique').on(table.tokenHash),
  index('sessions_user_expiry_idx').on(table.userId, table.expiresAt),
]);

export const recoveryTokens = app.table('recovery_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt,
}, (table) => [uniqueIndex('recovery_tokens_hash_unique').on(table.tokenHash)]);

export const rateLimits = app.table('rate_limits', {
  bucket: text('bucket').notNull(),
  subjectHash: text('subject_hash').notNull(),
  count: integer('count').notNull().default(0),
  windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
  blockedUntil: timestamp('blocked_until', { withTimezone: true }),
  updatedAt,
}, (table) => [
  primaryKey({ columns: [table.bucket, table.subjectHash] }),
  check('rate_limits_count_nonnegative', sql`${table.count} >= 0`),
]);

// Better Auth owns these tables through its PostgreSQL adapter. The application
// role must use `app` as its search_path so model names resolve to this schema.
export const authUsers = app.table('auth_users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  emailVerified: boolean('emailVerified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('auth_users_email_unique').on(table.email)]);

export const authSessions = app.table('auth_sessions', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  token: text('token').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  userId: text('userId').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
}, (table) => [
  uniqueIndex('auth_sessions_token_unique').on(table.token),
  index('auth_sessions_user_id_idx').on(table.userId),
]);

export const authAccounts = app.table('auth_accounts', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull(),
  providerId: text('providerId').notNull(),
  userId: text('userId').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  idToken: text('idToken'),
  accessTokenExpiresAt: timestamp('accessTokenExpiresAt', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('auth_accounts_user_id_idx').on(table.userId),
  uniqueIndex('auth_accounts_provider_account_unique').on(table.providerId, table.accountId),
]);

export const authVerifications = app.table('auth_verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('auth_verifications_identifier_idx').on(table.identifier)]);

export const authRateLimits = app.table('auth_rate_limits', {
  id: text('id').primaryKey(),
  key: text('key').notNull(),
  count: integer('count').notNull(),
  lastRequest: bigint('lastRequest', { mode: 'number' }).notNull(),
}, (table) => [
  uniqueIndex('auth_rate_limits_key_unique').on(table.key),
  check('auth_rate_limits_count_nonnegative', sql`${table.count} >= 0`),
]);

export const accounts = app.table('accounts', {
  id: uuid('id').defaultRandom().primaryKey(),
  provider: provider('provider').notNull(),
  providerAccountId: text('provider_account_id').notNull(),
  email: text('email').notNull(),
  displayName: text('display_name'),
  state: accountState('state').notNull().default('pending'),
  baselineCompletedAt: timestamp('baseline_completed_at', { withTimezone: true }),
  autonomyPausedAt: timestamp('autonomy_paused_at', { withTimezone: true }),
  autonomyPauseReason: text('autonomy_pause_reason'),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex('accounts_provider_identity_unique').on(table.provider, table.providerAccountId),
  uniqueIndex('accounts_email_unique').on(table.email),
]);

export const userAccounts = app.table('user_accounts', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  createdAt,
}, (table) => [
  primaryKey({ columns: [table.userId, table.accountId] }),
  index('user_accounts_account_idx').on(table.accountId),
]);

export const folders = app.table('folders', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  providerFolderId: text('provider_folder_id').notNull(),
  name: text('name').notNull(),
  role: text('role'),
  parentProviderFolderId: text('parent_provider_folder_id'),
  selectable: boolean('selectable').notNull().default(true),
  updatedAt,
}, (table) => [
  uniqueIndex('folders_provider_identity_unique').on(table.accountId, table.providerFolderId),
  index('folders_account_role_idx').on(table.accountId, table.role),
]);

export const messages = app.table('messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  providerMessageId: text('provider_message_id').notNull(),
  providerThreadId: text('provider_thread_id'),
  folderId: uuid('folder_id').references(() => folders.id, { onDelete: 'set null' }),
  internetMessageId: text('internet_message_id'),
  sender: jsonb('sender').$type<{ name?: string; address: string }>().notNull(),
  recipients: jsonb('recipients').$type<Array<{ kind: 'to' | 'cc' | 'bcc'; name?: string; address: string }>>().notNull(),
  subject: text('subject').notNull().default(''),
  preview: text('preview').notNull().default(''),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  isRead: boolean('is_read').notNull().default(false),
  isBaseline: boolean('is_baseline').notNull().default(false),
  hasAttachments: boolean('has_attachments').notNull().default(false),
  providerVersion: text('provider_version'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex('messages_provider_identity_unique').on(table.accountId, table.providerMessageId),
  index('messages_inbox_page_idx').on(table.accountId, table.receivedAt, table.id),
  index('messages_internet_message_idx').on(table.accountId, table.internetMessageId),
]);

export const messageBodies = app.table('message_bodies', {
  messageId: uuid('message_id').primaryKey().references(() => messages.id, { onDelete: 'cascade' }),
  textBody: text('text_body'),
  sanitizedHtmlBody: text('sanitized_html_body'),
  cachedAt: timestamp('cached_at', { withTimezone: true }).notNull().defaultNow(),
  purgeAfter: timestamp('purge_after', { withTimezone: true }).notNull(),
}, (table) => [index('message_bodies_purge_idx').on(table.purgeAfter), index('message_bodies_cached_at_idx').on(table.cachedAt)]);

export const attachments = app.table('attachments', {
  id: uuid('id').defaultRandom().primaryKey(),
  messageId: uuid('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  providerAttachmentId: text('provider_attachment_id').notNull(),
  filename: text('filename').notNull(),
  mediaType: text('media_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  inline: boolean('inline').notNull().default(false),
  contentId: text('content_id'),
  createdAt,
}, (table) => [
  uniqueIndex('attachments_provider_identity_unique').on(table.messageId, table.providerAttachmentId),
  check('attachments_size_nonnegative', sql`${table.sizeBytes} >= 0`),
]);

export const activities = app.table('activities', {
  id: uuid('id').defaultRandom().primaryKey(),
  messageId: uuid('message_id').notNull().references(() => messages.id, { onDelete: 'restrict' }),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'restrict' }),
  state: activityState('state').notNull().default('new'),
  lastErrorCode: text('last_error_code'),
  handledAt: timestamp('handled_at', { withTimezone: true }),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex('activities_message_unique').on(table.messageId),
  index('activities_state_created_idx').on(table.state, table.createdAt, table.id),
  check('activities_version_positive', sql`${table.version} > 0`),
]);

export const agentJobs = app.table('agent_jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'restrict' }),
  idempotencyKey: text('idempotency_key').notNull(),
  state: jobState('state').notNull().default('pending'),
  attempt: integer('attempt').notNull().default(0),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  lastErrorCode: text('last_error_code'),
  queueJobId: text('queue_job_id'),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex('agent_jobs_activity_unique').on(table.activityId),
  uniqueIndex('agent_jobs_idempotency_unique').on(table.idempotencyKey),
  check('agent_jobs_attempt_nonnegative', sql`${table.attempt} >= 0`),
]);

export const decisions = app.table('decisions', {
  id: uuid('id').defaultRandom().primaryKey(),
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'restrict' }),
  attempt: integer('attempt').notNull(),
  state: decisionState('state').notNull(),
  rationale: text('rationale').notNull(),
  modelProvider: text('model_provider').notNull(),
  modelName: text('model_name').notNull(),
  inputDigest: text('input_digest').notNull(),
  output: jsonb('output').$type<Record<string, unknown>>().notNull(),
  createdAt,
}, (table) => [
  uniqueIndex('decisions_activity_attempt_unique').on(table.activityId, table.attempt),
  check('decisions_attempt_positive', sql`${table.attempt} > 0`),
]);

export const questions = app.table('questions', {
  id: uuid('id').defaultRandom().primaryKey(),
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'restrict' }),
  decisionId: uuid('decision_id').notNull().references(() => decisions.id, { onDelete: 'restrict' }),
  prompt: text('prompt').notNull(),
  state: questionState('state').notNull().default('open'),
  answer: text('answer'),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex('questions_one_open_per_activity').on(table.activityId).where(sql`${table.state} = 'open'`),
]);

export const actions = app.table('actions', {
  id: uuid('id').defaultRandom().primaryKey(),
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'restrict' }),
  decisionId: uuid('decision_id').notNull().references(() => decisions.id, { onDelete: 'restrict' }),
  kind: actionKind('kind').notNull(),
  state: actionState('state').notNull().default('planned'),
  idempotencyKey: text('idempotency_key').notNull(),
  target: jsonb('target').$type<Record<string, unknown>>().notNull(),
  precondition: jsonb('precondition').$type<Record<string, unknown>>().notNull(),
  providerReceipt: jsonb('provider_receipt').$type<Record<string, unknown>>(),
  errorCode: text('error_code'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex('actions_idempotency_unique').on(table.idempotencyKey),
  index('actions_activity_idx').on(table.activityId, table.createdAt),
]);

export const actionVerifications = app.table('action_verifications', {
  id: uuid('id').defaultRandom().primaryKey(),
  actionId: uuid('action_id').notNull().references(() => actions.id, { onDelete: 'restrict' }),
  attempt: integer('attempt').notNull(),
  state: verificationState('state').notNull(),
  observed: jsonb('observed').$type<Record<string, unknown>>().notNull(),
  errorCode: text('error_code'),
  createdAt,
}, (table) => [
  uniqueIndex('action_verifications_attempt_unique').on(table.actionId, table.attempt),
  check('action_verifications_attempt_positive', sql`${table.attempt} > 0`),
]);

export const drafts = app.table('drafts', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'restrict' }),
  sourceMessageId: uuid('source_message_id').references(() => messages.id, { onDelete: 'set null' }),
  providerDraftId: text('provider_draft_id'),
  createdBy: text('created_by').notNull(),
  state: draftState('state').notNull().default('editing'),
  recipients: jsonb('recipients').$type<Array<{ kind: 'to' | 'cc' | 'bcc'; address: string }>>().notNull(),
  subject: text('subject').notNull().default(''),
  body: text('body').notNull().default(''),
  version: integer('version').notNull().default(1),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex('drafts_provider_identity_unique').on(table.accountId, table.providerDraftId).where(sql`${table.providerDraftId} is not null`),
  check('drafts_version_positive', sql`${table.version} > 0`),
  check('drafts_creator_allowed', sql`${table.createdBy} in ('user', 'agent')`),
]);

export const draftRevisions = app.table('draft_revisions', {
  draftId: uuid('draft_id').notNull().references(() => drafts.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  editor: text('editor').notNull(),
  snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
  createdAt,
}, (table) => [
  primaryKey({ columns: [table.draftId, table.version] }),
  check('draft_revisions_version_positive', sql`${table.version} > 0`),
]);

export const sendApprovals = app.table('send_approvals', {
  id: uuid('id').defaultRandom().primaryKey(),
  draftId: uuid('draft_id').notNull().references(() => drafts.id, { onDelete: 'restrict' }),
  draftVersion: integer('draft_version').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  state: sendApprovalState('state').notNull().default('pending'),
  confirmationHash: text('confirmation_hash').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt,
}, (table) => [
  uniqueIndex('send_approvals_confirmation_unique').on(table.confirmationHash),
  uniqueIndex('send_approvals_idempotency_unique').on(table.idempotencyKey),
]);

export const logicalNotifications = app.table('logical_notifications', {
  id: uuid('id').defaultRandom().primaryKey(),
  activityId: uuid('activity_id').notNull().references(() => activities.id, { onDelete: 'restrict' }),
  state: notificationState('state').notNull().default('pending'),
  senderLabel: text('sender_label').notNull(),
  subject: text('subject').notNull(),
  statusLabel: text('status_label').notNull(),
  createdAt,
  updatedAt,
}, (table) => [uniqueIndex('logical_notifications_activity_unique').on(table.activityId)]);

export const pushSubscriptions = app.table('push_subscriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  endpointHash: text('endpoint_hash').notNull(),
  endpointCiphertext: text('endpoint_ciphertext').notNull(),
  p256dhCiphertext: text('p256dh_ciphertext').notNull(),
  authCiphertext: text('auth_ciphertext').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex('push_subscriptions_endpoint_unique').on(table.endpointHash),
  index('push_subscriptions_expiry_cleanup_idx').on(table.expiresAt).where(sql`${table.disabledAt} is null and ${table.expiresAt} is not null`),
]);

export const notificationDeliveries = app.table('notification_deliveries', {
  id: uuid('id').defaultRandom().primaryKey(),
  notificationId: uuid('notification_id').notNull().references(() => logicalNotifications.id, { onDelete: 'restrict' }),
  subscriptionId: uuid('subscription_id').notNull().references(() => pushSubscriptions.id, { onDelete: 'restrict' }),
  attempt: integer('attempt').notNull(),
  state: deliveryState('state').notNull().default('pending'),
  responseCode: integer('response_code'),
  errorCode: text('error_code'),
  createdAt,
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('notification_deliveries_attempt_unique').on(table.notificationId, table.subscriptionId, table.attempt),
  check('notification_deliveries_attempt_positive', sql`${table.attempt} > 0`),
]);

export const pollStates = app.table('poll_states', {
  accountId: uuid('account_id').primaryKey().references(() => accounts.id, { onDelete: 'cascade' }),
  checkpointObservedAt: timestamp('checkpoint_observed_at', { withTimezone: true }),
  lastPollStartedAt: timestamp('last_poll_started_at', { withTimezone: true }),
  lastPollSucceededAt: timestamp('last_poll_succeeded_at', { withTimezone: true }),
  lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastErrorCode: text('last_error_code'),
  updatedAt,
}, (table) => [check('poll_states_failures_nonnegative', sql`${table.consecutiveFailures} >= 0`)]);

export const accountHealth = app.table('account_health', {
  accountId: uuid('account_id').primaryKey().references(() => accounts.id, { onDelete: 'cascade' }),
  state: healthState('state').notNull().default('healthy'),
  reasonCode: text('reason_code'),
  detail: text('detail'),
  firstObservedAt: timestamp('first_observed_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt,
});

export const schedulerLeases = app.table('scheduler_leases', {
  name: text('name').primaryKey(),
  holderId: text('holder_id').notNull(),
  fencingToken: integer('fencing_token').notNull(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (table) => [check('scheduler_leases_fencing_positive', sql`${table.fencingToken} > 0`)]);

export const safetyWindows = app.table('safety_windows', {
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
  verifiedMutations: integer('verified_mutations').notNull().default(0),
  incorrectMutations: integer('incorrect_mutations').notNull().default(0),
  updatedAt,
}, (table) => [
  primaryKey({ columns: [table.accountId, table.windowStartedAt] }),
  check('safety_windows_verified_nonnegative', sql`${table.verifiedMutations} >= 0`),
  check('safety_windows_incorrect_nonnegative', sql`${table.incorrectMutations} >= 0`),
  check('safety_windows_incorrect_bounded', sql`${table.incorrectMutations} <= ${table.verifiedMutations}`),
]);

export const audits = app.table('audits', {
  id: uuid('id').defaultRandom().primaryKey(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id'),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  activityId: uuid('activity_id').references(() => activities.id, { onDelete: 'set null' }),
  event: text('event').notNull(),
  correlationId: text('correlation_id').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
}, (table) => [
  index('audits_occurred_idx').on(table.occurredAt, table.id),
  index('audits_activity_idx').on(table.activityId, table.occurredAt),
]);
