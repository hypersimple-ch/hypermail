import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
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
export const agentConnectionState = app.enum('agent_connection_state', ['connected', 'paused', 'disconnected', 'security_revoked']);
export const mailboxManagerKind = app.enum('mailbox_manager_kind', ['mastra', 'agent_connection', 'none']);
export const capabilityGrantState = app.enum('capability_grant_state', ['active', 'revoked', 'reapproval_required']);
export const publicSendRequestState = app.enum('public_send_request_state', ['pending_owner_approval', 'expired', 'cancelled', 'approved', 'rejected', 'sending', 'failed', 'unverifiable']);
export const agentTaskState = app.enum('agent_task_state', ['pending','leased','waiting_for_answer','awaiting_action_verification','completed','cancelled','obsolete','dead_letter']);
export const agentTaskPendingReason = app.enum('agent_task_pending_reason', ['initial','retry','continuation','owner_resumed']);
export const agentTaskErrorCode = app.enum('agent_task_error_code', ['MANAGER_UNAVAILABLE','RATE_LIMITED','DEPENDENCY_UNAVAILABLE','LEASE_EXPIRED','DEADLINE_EXCEEDED','INVALID_REPORT','AUTHORIZATION_REVOKED','OWNER_CANCELLED','INTERNAL']);
export const agentTaskOutboxEvent = app.enum('agent_task_outbox_event', ['task_available','task_obsolete','question_answered','task_terminal']);
export const agentTaskReportKind = app.enum('agent_task_report_kind', ['heartbeat','result','failure','answer']);

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
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
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
  uniqueIndex('accounts_user_provider_identity_unique').on(table.userId, table.provider, table.providerAccountId),
  uniqueIndex('accounts_user_email_unique').on(table.userId, sql`lower(${table.email})`),
  uniqueIndex('accounts_user_id_id_unique').on(table.userId, table.id),
]);

export const userAccounts = app.table('user_accounts', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  createdAt,
}, (table) => [
  primaryKey({ columns: [table.userId, table.accountId] }),
  uniqueIndex('user_accounts_account_unique').on(table.accountId),
  index('user_accounts_account_idx').on(table.accountId),
  foreignKey({ columns: [table.userId, table.accountId], foreignColumns: [accounts.userId, accounts.id], name: 'user_accounts_owned_account_fk' }).onDelete('cascade'),
]);

export const agentConnections = app.table('agent_connections', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  adapter: text('adapter').notNull(),
  externalProfileId: text('external_profile_id').notNull(),
  displayName: text('display_name').notNull(),
  state: agentConnectionState('state').notNull().default('connected'),
  lifecycleRevision: integer('lifecycle_revision').notNull().default(1),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex('agent_connections_external_profile_unique').on(table.userId, table.adapter, table.externalProfileId),
  uniqueIndex('agent_connections_user_id_unique').on(table.userId, table.id),
  index('agent_connections_user_state_idx').on(table.userId, table.state),
  check('agent_connections_adapter_valid', sql`${table.adapter} ~ '^[a-z][a-z0-9_-]*$'`),
  check('agent_connections_external_profile_nonempty', sql`length(btrim(${table.externalProfileId})) > 0`),
  check('agent_connections_lifecycle_revision_positive', sql`${table.lifecycleRevision} > 0`),
]);

export const agentConnectionReconnectProofs = app.table('agent_connection_reconnect_proofs', {
  eventId: text('event_id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  connectionId: uuid('connection_id').notNull().references(() => agentConnections.id, { onDelete: 'restrict' }),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  lifecycleRevision: integer('lifecycle_revision'),
});

export const agentConnectionReconnectEvents = app.table('agent_connection_reconnect_events', {
  eventId: text('event_id').primaryKey(),
  connectionId: uuid('connection_id').notNull().references(() => agentConnections.id, { onDelete: 'restrict' }),
  lifecycleRevision: integer('lifecycle_revision').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
}, (table) => [uniqueIndex('agent_connection_reconnect_events_revision_unique').on(table.connectionId, table.lifecycleRevision)]);

export const userAgentPreferences = app.table('user_agent_preferences', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  defaultManagerKind: mailboxManagerKind('default_manager_kind').notNull(),
  defaultAgentConnectionId: uuid('default_agent_connection_id'),
  revision: integer('revision').notNull().default(1),
  updatedAt,
}, (table) => [
  foreignKey({
    columns: [table.userId, table.defaultAgentConnectionId],
    foreignColumns: [agentConnections.userId, agentConnections.id],
    name: 'user_agent_preferences_owned_connection_fk',
  }).onDelete('restrict'),
  check('user_agent_preferences_manager_reference', sql`(
    (${table.defaultManagerKind} = 'agent_connection' and ${table.defaultAgentConnectionId} is not null)
    or (${table.defaultManagerKind} in ('mastra', 'none') and ${table.defaultAgentConnectionId} is null)
  )`),
  check('user_agent_preferences_revision_positive', sql`${table.revision} > 0`),
]);

export const mailboxManagerAssignments = app.table('mailbox_manager_assignments', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull(),
  accountId: uuid('account_id').notNull(),
  managerKind: mailboxManagerKind('manager_kind').notNull(),
  agentConnectionId: uuid('agent_connection_id'),
  automaticProcessingEnabled: boolean('automatic_processing_enabled').notNull().default(false),
  revision: integer('revision').notNull().default(1),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex('mailbox_manager_assignments_user_account_unique').on(table.userId, table.accountId),
  uniqueIndex('mailbox_manager_assignments_identity_unique').on(table.id, table.userId, table.accountId),
  foreignKey({
    columns: [table.userId, table.accountId],
    foreignColumns: [userAccounts.userId, userAccounts.accountId],
    name: 'mailbox_manager_assignments_owned_mailbox_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [table.userId, table.agentConnectionId],
    foreignColumns: [agentConnections.userId, agentConnections.id],
    name: 'mailbox_manager_assignments_owned_connection_fk',
  }).onDelete('restrict'),
  check('mailbox_manager_assignments_manager_reference', sql`(
    (${table.managerKind} = 'agent_connection' and ${table.agentConnectionId} is not null)
    or (${table.managerKind} in ('mastra', 'none') and ${table.agentConnectionId} is null)
  )`),
  check('mailbox_manager_assignments_revision_positive', sql`${table.revision} > 0`),
]);

export const mailboxManagerAssignmentRevisions = app.table('mailbox_manager_assignment_revisions', {
  assignmentId: uuid('assignment_id').notNull(),
  revision: integer('revision').notNull(),
  userId: uuid('user_id').notNull(),
  accountId: uuid('account_id').notNull(),
  managerKind: mailboxManagerKind('manager_kind').notNull(),
  agentConnectionId: uuid('agent_connection_id'),
  automaticProcessingEnabled: boolean('automatic_processing_enabled').notNull(),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.assignmentId, table.revision] }),
  foreignKey({
    columns: [table.assignmentId, table.userId, table.accountId],
    foreignColumns: [mailboxManagerAssignments.id, mailboxManagerAssignments.userId, mailboxManagerAssignments.accountId],
    name: 'mailbox_manager_assignment_revisions_assignment_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [table.userId, table.agentConnectionId],
    foreignColumns: [agentConnections.userId, agentConnections.id],
    name: 'mailbox_manager_assignment_revisions_owned_connection_fk',
  }).onDelete('restrict'),
  check('mailbox_manager_assignment_revisions_manager_reference', sql`(
    (${table.managerKind} = 'agent_connection' and ${table.agentConnectionId} is not null)
    or (${table.managerKind} in ('mastra', 'none') and ${table.agentConnectionId} is null)
  )`),
  check('mailbox_manager_assignment_revisions_revision_positive', sql`${table.revision} > 0`),
]);

export const agentCapabilityGrants = app.table('agent_capability_grants', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull(),
  accountId: uuid('account_id').notNull(),
  managerKind: mailboxManagerKind('manager_kind').notNull(),
  agentConnectionId: uuid('agent_connection_id'),
  capabilities: text('capabilities').array().notNull(),
  invocationModes: text('invocation_modes').array().notNull(),
  state: capabilityGrantState('state').notNull().default('active'),
  revision: integer('revision').notNull().default(1),
  approvedAt: timestamp('approved_at', { withTimezone: true }).notNull(),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex('agent_capability_grants_user_account_unique').on(table.userId, table.accountId),
  uniqueIndex('agent_capability_grants_identity_unique').on(table.id, table.userId, table.accountId),
  foreignKey({
    columns: [table.userId, table.accountId],
    foreignColumns: [mailboxManagerAssignments.userId, mailboxManagerAssignments.accountId],
    name: 'agent_capability_grants_assignment_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [table.userId, table.agentConnectionId],
    foreignColumns: [agentConnections.userId, agentConnections.id],
    name: 'agent_capability_grants_owned_connection_fk',
  }).onDelete('restrict'),
  check('agent_capability_grants_manager_reference', sql`(
    (${table.managerKind} = 'agent_connection' and ${table.agentConnectionId} is not null)
    or (${table.managerKind} = 'mastra' and ${table.agentConnectionId} is null)
  )`),
  check('agent_capability_grants_revision_positive', sql`${table.revision} > 0`),
  check('agent_capability_grants_capabilities_nonempty', sql`cardinality(${table.capabilities}) > 0 and app.text_array_is_unique(${table.capabilities})`),
  check('agent_capability_grants_invocation_modes_nonempty', sql`cardinality(${table.invocationModes}) > 0 and app.text_array_is_unique(${table.invocationModes})`),
]);

export const agentCapabilityGrantRevisions = app.table('agent_capability_grant_revisions', {
  grantId: uuid('grant_id').notNull(),
  revision: integer('revision').notNull(),
  userId: uuid('user_id').notNull(),
  accountId: uuid('account_id').notNull(),
  managerKind: mailboxManagerKind('manager_kind').notNull(),
  agentConnectionId: uuid('agent_connection_id'),
  capabilities: text('capabilities').array().notNull(),
  invocationModes: text('invocation_modes').array().notNull(),
  state: capabilityGrantState('state').notNull(),
  approvedAt: timestamp('approved_at', { withTimezone: true }).notNull(),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.grantId, table.revision] }),
  foreignKey({
    columns: [table.grantId, table.userId, table.accountId],
    foreignColumns: [agentCapabilityGrants.id, agentCapabilityGrants.userId, agentCapabilityGrants.accountId],
    name: 'agent_capability_grant_revisions_grant_fk',
  }).onDelete('restrict'),
  foreignKey({
    columns: [table.userId, table.agentConnectionId],
    foreignColumns: [agentConnections.userId, agentConnections.id],
    name: 'agent_capability_grant_revisions_owned_connection_fk',
  }).onDelete('restrict'),
  check('agent_capability_grant_revisions_manager_reference', sql`(
    (${table.managerKind} = 'agent_connection' and ${table.agentConnectionId} is not null)
    or (${table.managerKind} = 'mastra' and ${table.agentConnectionId} is null)
  )`),
  check('agent_capability_grant_revisions_revision_positive', sql`${table.revision} > 0`),
]);

export const capabilityGrantReapprovalEvents = app.table('capability_grant_reapproval_events', {
  eventId: text('event_id').primaryKey(),
  grantId: uuid('grant_id').notNull(),
  grantRevision: integer('grant_revision').notNull(),
  approverUserId: uuid('approver_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  approvedAt: timestamp('approved_at', { withTimezone: true }).notNull(),
}, (table) => [
  foreignKey({ columns: [table.grantId, table.grantRevision], foreignColumns: [agentCapabilityGrantRevisions.grantId, agentCapabilityGrantRevisions.revision], name: 'capability_grant_reapproval_events_revision_fk' }).onDelete('restrict'),
]);

export const oauthPublicClients = app.table('oauth_public_clients', {
  clientId: text('client_id').primaryKey(), displayName: text('display_name').notNull(), userId: uuid('user_id').notNull(), agentConnectionId: uuid('agent_connection_id').notNull(), allowedScope: text('allowed_scope').notNull().default('agent:mailbox'), revokedAt: timestamp('revoked_at', { withTimezone: true }), redirectUris: text('redirect_uris').array().notNull(), createdAt,
});
export const agentSafetyCeiling = app.table('agent_safety_ceiling', {
  singleton: boolean('singleton').primaryKey().default(true), revision: integer('revision').notNull().default(1),
  capabilities: text('capabilities').array().notNull(), invocationModes: text('invocation_modes').array().notNull(), updatedAt,
});
export const oauthConsentRequests = app.table('oauth_consent_requests', {
  requestDigest: text('request_digest').primaryKey(), clientId: text('client_id').notNull().references(() => oauthPublicClients.clientId), redirectUri: text('redirect_uri').notNull(), userId: uuid('user_id').notNull(), connectionId: uuid('connection_id').notNull(), accountId: uuid('account_id'), scope: text('scope').notNull(), codeChallenge: text('code_challenge').notNull(), state: text('state'), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), consumedAt: timestamp('consumed_at', { withTimezone: true }), createdAt,
});
export const oauthAuthorizationCodes = app.table('oauth_authorization_codes', {
  codeDigest: text('code_digest').primaryKey(), clientId: text('client_id').notNull().references(() => oauthPublicClients.clientId),
  redirectUri: text('redirect_uri').notNull(), userId: uuid('user_id').notNull().references(() => users.id),
  connectionId: uuid('connection_id').notNull().references(() => agentConnections.id), accountId: uuid('account_id').notNull().references(() => accounts.id),
  codeChallenge: text('code_challenge').notNull(), scope: text('scope').notNull(), lifecycleRevision: integer('lifecycle_revision').notNull(), assignmentRevision: integer('assignment_revision').notNull(), grantRevision: integer('grant_revision').notNull(), safetyRevision: integer('safety_revision').notNull(), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }), createdAt,
});
export const oauthTokenFamilies = app.table('oauth_token_families', {
  id: uuid('id').defaultRandom().primaryKey(), clientId: text('client_id').notNull().references(() => oauthPublicClients.clientId),
  userId: uuid('user_id').notNull(), connectionId: uuid('connection_id').notNull(), accountId: uuid('account_id').notNull(),
  currentGeneration: integer('current_generation').notNull().default(0), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), revocationReason: text('revocation_reason'), revokedAt: timestamp('revoked_at', { withTimezone: true }), createdAt,
});
export const oauthTokens = app.table('oauth_tokens', {
  tokenDigest: text('token_digest').primaryKey(), familyId: uuid('family_id').notNull().references(() => oauthTokenFamilies.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), generation: integer('generation').notNull(), audience: text('audience').notNull(), scope: text('scope').notNull(), lifecycleRevision: integer('lifecycle_revision').notNull(),
  assignmentRevision: integer('assignment_revision').notNull(), grantRevision: integer('grant_revision').notNull(), safetyRevision: integer('safety_revision').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), consumedAt: timestamp('consumed_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }), createdAt,
}, (table) => [index('oauth_tokens_family_idx').on(table.familyId)]);

export const agentActivityKind = app.enum('agent_activity_kind', ['arrival', 'interactive_request', 'safety_event', 'external_change']);
export const agentActivityState = app.enum('agent_activity_state', ['open', 'waiting_for_answer', 'resolved', 'attention_required', 'acknowledged']);
export const agentRunState = app.enum('agent_run_state', ['created', 'running', 'completed']);
export const agentRunOutcome = app.enum('agent_run_outcome', ['action_requests_emitted', 'question_asked', 'no_action', 'failed', 'cancelled']);
export const agentInvocationMode = app.enum('agent_invocation_mode', ['interactive', 'automatic']);
export const agentWorkManagerKind = app.enum('agent_work_manager_kind', ['mastra', 'agent_connection', 'legacy_mastra']);
export const agentActionKind = app.enum('agent_action_kind', ['archive', 'recoverable_trash', 'move', 'mark_read', 'mark_unread', 'draft_create', 'draft_edit', 'send']);
export const agentActionState = app.enum('agent_action_state', ['authorized', 'executing', 'verifying', 'verified', 'failed', 'unverifiable', 'cancelled']);

export const agentConnectionLifecycleRevisions = app.table('agent_connection_lifecycle_revisions', {
  connectionId: uuid('connection_id').notNull(), revision: integer('revision').notNull(), userId: uuid('user_id').notNull(),
  state: agentConnectionState('state').notNull(), verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(), changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.connectionId, table.revision] })]);
export const agentSafetyCeilingRevisions = app.table('agent_safety_ceiling_revisions', {
  singleton: boolean('singleton').notNull().default(true), revision: integer('revision').notNull(), capabilities: text('capabilities').array().notNull(),
  invocationModes: text('invocation_modes').array().notNull(), changedAt: timestamp('changed_at', { withTimezone: true }).notNull(),
}, table => [primaryKey({ columns: [table.singleton, table.revision] })]);
export const agentActivities = app.table('agent_activities', {
  id: uuid('id').defaultRandom().primaryKey(), userId: uuid('user_id').notNull(), accountId: uuid('account_id').notNull(), kind: agentActivityKind('kind').notNull(),
  sourceMessageId: uuid('source_message_id'), correlationId: text('correlation_id').notNull(), causationId: uuid('causation_id'), state: agentActivityState('state').notNull().default('open'),
  revision: integer('revision').notNull().default(1), createdAt, updatedAt,
}, table => [uniqueIndex('agent_activities_identity_unique').on(table.id, table.userId, table.accountId), uniqueIndex('agent_activities_correlation_unique').on(table.userId, table.accountId, table.correlationId)]);
export const agentRuns = app.table('agent_runs', {
  id: uuid('id').defaultRandom().primaryKey(), activityId: uuid('activity_id').notNull(), userId: uuid('user_id').notNull(), accountId: uuid('account_id').notNull(), sequence: integer('sequence').notNull(),
  managerKind: agentWorkManagerKind('manager_kind').notNull(), managerConnectionId: uuid('manager_connection_id'), managerLegacySourceId: text('manager_legacy_source_id'), managerLifecycleRevision: integer('manager_lifecycle_revision'),
  assignmentId: uuid('assignment_id').notNull(), assignmentRevision: integer('assignment_revision').notNull(), grantId: uuid('grant_id').notNull(), grantRevision: integer('grant_revision').notNull(), safetyRevision: integer('safety_revision').notNull(),
  mode: agentInvocationMode('mode').notNull(), trigger: jsonb('trigger').$type<Record<string, unknown>>().notNull(), inputDigest: text('input_digest').notNull(), correlationId: text('correlation_id').notNull(), causationId: uuid('causation_id'),
  state: agentRunState('state').notNull().default('created'), outcome: agentRunOutcome('outcome'), errorCode: text('error_code'), createdAt, startedAt: timestamp('started_at', { withTimezone: true }), completedAt: timestamp('completed_at', { withTimezone: true }),
}, table => [uniqueIndex('agent_runs_identity_unique').on(table.id, table.userId, table.accountId), uniqueIndex('agent_runs_activity_sequence_unique').on(table.activityId, table.sequence)]);
export const agentTasks = app.table('agent_tasks', {
  id: uuid('id').primaryKey(), enqueueKey: text('enqueue_key').notNull(), activityId: uuid('activity_id').notNull(), userId: uuid('user_id').notNull(), accountId: uuid('account_id').notNull(),
  managerKind: mailboxManagerKind('manager_kind').notNull(), managerConnectionId: uuid('manager_connection_id'), managerLifecycleRevision: integer('manager_lifecycle_revision'), assignmentId: uuid('assignment_id').notNull(), assignmentRevision: integer('assignment_revision').notNull(), grantId: uuid('grant_id').notNull(), grantRevision: integer('grant_revision').notNull(), safetyRevision: integer('safety_revision').notNull(),
  state: agentTaskState('state').notNull().default('pending'), pendingReason: agentTaskPendingReason('pending_reason'), version: integer('version').notNull().default(1), attemptCount: integer('attempt_count').notNull().default(0), maxAttempts: integer('max_attempts').notNull().default(5), leaseGeneration: integer('lease_generation').notNull().default(0), leaseTokenDigest: text('lease_token_digest'), leaseClaimedBy: text('lease_claimed_by'), leaseClaimedAt: timestamp('lease_claimed_at',{withTimezone:true}), leaseHeartbeatAt: timestamp('lease_heartbeat_at',{withTimezone:true}), leaseExpiresAt: timestamp('lease_expires_at',{withTimezone:true}), currentRunId: uuid('current_run_id'), result: jsonb('result'), lastErrorCode: agentTaskErrorCode('last_error_code'), availableAt: timestamp('available_at',{withTimezone:true}).notNull(), deadlineAt: timestamp('deadline_at',{withTimezone:true}).notNull(), createdAt, updatedAt, completedAt: timestamp('completed_at',{withTimezone:true}), obsoleteAt: timestamp('obsolete_at',{withTimezone:true}),
}, table => [uniqueIndex('agent_tasks_enqueue_key_unique').on(table.enqueueKey), index('agent_tasks_claim_idx').on(table.managerKind,table.managerConnectionId,table.availableAt,table.createdAt), index('agent_tasks_expired_lease_idx').on(table.leaseExpiresAt)]);
export const agentTaskDeliveryAttempts = app.table('agent_task_delivery_attempts', { id:uuid('id').primaryKey(),taskId:uuid('task_id').notNull(),number:integer('number').notNull(),leaseGeneration:integer('lease_generation').notNull(),runId:uuid('run_id').notNull(),managerKind:mailboxManagerKind('manager_kind').notNull(),managerConnectionId:uuid('manager_connection_id'),requestId:text('request_id').notNull(),requestDigest:text('request_digest').notNull(),startedAt:timestamp('started_at',{withTimezone:true}).notNull(),endedAt:timestamp('ended_at',{withTimezone:true}),errorCode:agentTaskErrorCode('error_code') }, table=>[uniqueIndex('agent_task_attempt_number_unique').on(table.taskId,table.number),uniqueIndex('agent_task_attempt_generation_unique').on(table.taskId,table.leaseGeneration),uniqueIndex('agent_task_attempt_request_unique').on(table.taskId,table.requestId)]);
export const agentTaskReports = app.table('agent_task_reports', { id:uuid('id').primaryKey(),taskId:uuid('task_id').notNull(),attemptId:uuid('attempt_id'),leaseGeneration:integer('lease_generation').notNull(),kind:agentTaskReportKind('kind').notNull(),requestId:text('request_id').notNull(),requestDigest:text('request_digest').notNull(),accepted:boolean('accepted').notNull(),errorCode:agentTaskErrorCode('error_code'),occurredAt:timestamp('occurred_at',{withTimezone:true}).notNull(),responseSnapshot:jsonb('response_snapshot').notNull() },table=>[uniqueIndex('agent_task_reports_request_unique').on(table.taskId,table.requestId)]);
export const agentTaskReceipts = app.table('agent_task_receipts',{id:uuid('id').primaryKey(),taskId:uuid('task_id').notNull(),outboxId:uuid('outbox_id'),transport:text('transport').notNull(),receiptId:text('receipt_id').notNull(),receivedAt:timestamp('received_at',{withTimezone:true}).notNull()},table=>[uniqueIndex('agent_task_receipts_transport_unique').on(table.transport,table.receiptId)]);
export const agentTaskOutbox = app.table('agent_task_outbox',{id:uuid('id').primaryKey(),taskId:uuid('task_id').notNull(),activityId:uuid('activity_id').notNull(),accountId:uuid('account_id').notNull(),event:agentTaskOutboxEvent('event').notNull(),taskVersion:integer('task_version').notNull(),payloadDigest:text('payload_digest').notNull(),correlationId:text('correlation_id').notNull(),occurredAt:timestamp('occurred_at',{withTimezone:true}).notNull(),availableAt:timestamp('available_at',{withTimezone:true}).notNull(),publishedAt:timestamp('published_at',{withTimezone:true}),publishAttempts:integer('publish_attempts').notNull().default(0),lastError:text('last_error')},table=>[uniqueIndex('agent_task_outbox_version_event_unique').on(table.taskId,table.taskVersion,table.event),index('agent_task_outbox_pending_idx').on(table.availableAt,table.occurredAt)]);
export const agentMutationIdempotency = app.table('agent_mutation_idempotency',{accountId:uuid('account_id').notNull(),operation:text('operation').notNull(),idempotencyKey:text('idempotency_key').notNull(),requestDigest:text('request_digest').notNull(),state:text('state').notNull(),result:jsonb('result'),createdAt,updatedAt},table=>[primaryKey({columns:[table.accountId,table.operation,table.idempotencyKey]})]);

export const agentAuthorizedActions = app.table('agent_authorized_actions', {
  id: uuid('id').defaultRandom().primaryKey(), activityId: uuid('activity_id').notNull(), runId: uuid('run_id').notNull(), userId: uuid('user_id').notNull(), accountId: uuid('account_id').notNull(), correlationId: text('correlation_id').notNull(), causationId: uuid('causation_id').notNull(),
  managerKind: agentWorkManagerKind('manager_kind').notNull(), managerConnectionId: uuid('manager_connection_id'), managerLifecycleRevision: integer('manager_lifecycle_revision'), managerLegacySourceId: text('manager_legacy_source_id'), mode: agentInvocationMode('mode').notNull(),
  assignmentId: uuid('assignment_id').notNull(), assignmentRevision: integer('assignment_revision').notNull(), grantId: uuid('grant_id').notNull(), grantRevision: integer('grant_revision').notNull(), safetyRevision: integer('safety_revision').notNull(),
  kind: agentActionKind('kind').notNull(), target: jsonb('target').$type<Record<string, string>>().notNull(), authorizationRevision: integer('authorization_revision').notNull(), idempotencyKey: text('idempotency_key').notNull(), attempt: integer('attempt').notNull(), retryOfActionId: uuid('retry_of_action_id'),
  state: agentActionState('state').notNull().default('authorized'), errorCode: text('error_code'), authorizedAt: timestamp('authorized_at', { withTimezone: true }).notNull().defaultNow(), startedAt: timestamp('started_at', { withTimezone: true }), providerReportedAt: timestamp('provider_reported_at', { withTimezone: true }), completedAt: timestamp('completed_at', { withTimezone: true }),
}, table => [uniqueIndex('agent_authorized_actions_identity_unique').on(table.id, table.userId, table.accountId), uniqueIndex('agent_authorized_actions_idempotency_unique').on(table.userId, table.accountId, table.idempotencyKey)]);
export const agentActionVerifications = app.table('agent_action_verifications', {
  actionId: uuid('action_id').primaryKey(), userId: uuid('user_id').notNull(), accountId: uuid('account_id').notNull(), verifier: text('verifier').notNull(), providerMutationId: text('provider_mutation_id'), evidenceDigest: text('evidence_digest').notNull(), observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
});
export const agentActivityEvents = app.table('agent_activity_events', {
  id: uuid('id').defaultRandom().primaryKey(), activityId: uuid('activity_id').notNull(), userId: uuid('user_id').notNull(), accountId: uuid('account_id').notNull(), sequence: integer('sequence').notNull(), correlationId: text('correlation_id').notNull(), causationId: uuid('causation_id'), occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(), detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
}, table => [uniqueIndex('agent_activity_events_sequence_unique').on(table.activityId, table.sequence)]);

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
  publicSendRequestId: uuid('public_send_request_id').references((): AnyPgColumn => publicMcpSendRequests.id, { onDelete: 'restrict' }),
  createdAt,
}, (table) => [
  uniqueIndex('send_approvals_public_request_unique').on(table.publicSendRequestId),
  uniqueIndex('send_approvals_confirmation_unique').on(table.confirmationHash),
  uniqueIndex('send_approvals_idempotency_unique').on(table.idempotencyKey),
]);

export const publicMcpSendRequests = app.table('public_mcp_send_requests', {
  id: uuid('id').defaultRandom().primaryKey(), userId: uuid('user_id').notNull(), accountId: uuid('account_id').notNull(), connectionId: uuid('connection_id').notNull(),
  draftId: uuid('draft_id').notNull().references(() => drafts.id, { onDelete: 'restrict' }), draftVersion: integer('draft_version').notNull(), activityId: uuid('activity_id').notNull(), authorizationDecisionId: uuid('authorization_decision_id').notNull(),
  lifecycleRevision: integer('lifecycle_revision').notNull(), assignmentRevision: integer('assignment_revision').notNull(), grantRevision: integer('grant_revision').notNull(), safetyRevision: integer('safety_revision').notNull(),
  state: publicSendRequestState('state').notNull().default('pending_owner_approval'), approvalId: uuid('approval_id').references(() => sendApprovals.id, { onDelete: 'restrict' }), runId: uuid('run_id'), actionId: uuid('action_id'),
  providerMessageId: text('provider_message_id'), expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), completedAt: timestamp('completed_at', { withTimezone: true }), reason: text('reason_code'), createdAt, updatedAt,
}, table => [
  uniqueIndex('public_send_request_retry_unique').on(table.userId, table.accountId, table.connectionId, table.draftId, table.draftVersion),
  uniqueIndex('public_send_request_approval_unique').on(table.approvalId), uniqueIndex('public_send_request_run_unique').on(table.runId), uniqueIndex('public_send_request_action_unique').on(table.actionId),
  index('public_send_request_owner_pending').on(table.userId, table.state, table.createdAt),
  foreignKey({ columns: [table.runId, table.userId, table.accountId], foreignColumns: [agentRuns.id, agentRuns.userId, agentRuns.accountId], name: 'public_send_request_owned_run' }).onDelete('restrict'),
  foreignKey({ columns: [table.actionId, table.userId, table.accountId], foreignColumns: [agentAuthorizedActions.id, agentAuthorizedActions.userId, agentAuthorizedActions.accountId], name: 'public_send_request_owned_action' }).onDelete('restrict'),
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
