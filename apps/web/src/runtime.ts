import postgres from 'postgres';
import { AuthService, createPostgresAuthStore, expiredSessionCookie, readSessionToken, sessionCookie } from '@hypermail/auth';
import { webEnvSchema } from '@hypermail/contracts';
import { createPostgresClient, UserAccountScopeStore } from '@hypermail/db';
import { HypermailReadClient } from '@hypermail/hypermail';
import { PostgresNotificationPersistence } from '@hypermail/notifications';
import { PrivateApprovedSendHttpProvider, type MailSendProvider } from '@hypermail/send';
import { PostgresActivityRepository } from './activity/postgres-repository.js';
import { ActivityService } from './activity/service.js';
import { createActivityRoutes } from './activity/routes.js';
import { PostgresAgentRepository } from './agent/postgres-repository.js';
import { AgentService } from './agent/service.js';
import { createAgentRoutes } from './agent/routes.js';
import { AttachmentDeliveryService, createAttachmentRoutes } from './attachments/index.js';
import { ScopedHypermailAttachmentReader } from './attachments/hypermail-reader.js';
import { PostgresDraftRepository } from './drafts/postgres-repository.js';
import { PostgresDraftSourceReader } from './drafts/postgres-source-reader.js';
import { PostgresDraftList } from './drafts/list.js';
import { DraftService } from './drafts/service.js';
import { createDraftRoutes } from './drafts/routes.js';
import { createAuthRoutes, type RouteRequest } from './auth/routes.js';
import { AuthSecretPushSubscriptionCodec } from './notifications/crypto-codec.js';
import type { Readable } from 'node:stream';

export type WebRequest = Readonly<{ method: string; pathname: string; query: Readonly<Record<string, string | undefined>>; origin: string | null; cookie: string | null; remoteAddress: string; correlationId: string; apiVersion: string | null; body: Readonly<Record<string, unknown>>; signal?: AbortSignal }>;
export type WebResponse = Readonly<{ status: number; body?: Readonly<Record<string, unknown>>; setCookie?: string; headers?: Readonly<Record<string, string>>; stream?: Readable; cleanup?: () => Promise<void> }>;
export interface WebRuntime { dispatch(request: WebRequest): Promise<WebResponse | null>; close(): Promise<void>; }
type Scope = Readonly<{ subjectId: string; accountIds: readonly string[]; freshAuthAt?: string }>;
const disabledSendProvider: MailSendProvider = { send: () => Promise.reject(new Error('Approved send is not configured.')) };

const webEnvironmentNames = [
  'NODE_ENV', 'DATABASE_URL', 'APP_ORIGIN', 'AUTH_SECRET', 'RECOVERY_RECIPIENT', 'HYPERMAIL_URL',
  'HYPERMAIL_KEY', 'HYPERMAIL_PROTOCOL_VERSION', 'VAPID_SUBJECT', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY',
  'PUSH_SUBSCRIPTION_ENCRYPTION_KEY', 'ATTACHMENT_TEMP_DIRECTORY', 'ATTACHMENT_MAX_BYTES', 'ATTACHMENT_ORPHAN_MAX_AGE_SECONDS',
  'APPROVED_SEND_URL', 'APPROVED_SEND_TOKEN',
] as const;

/** Production composition root. It uses the application AuthService, never Better Auth. */
export function createWebRuntimeFromEnvironment(environment: NodeJS.ProcessEnv): WebRuntime {
  const selected = Object.fromEntries(webEnvironmentNames.flatMap((name) => environment[name] === undefined ? [] : [[name, environment[name]]]));
  const parsed = webEnvSchema.safeParse(selected);
  if (!parsed.success) {
    const name = parsed.error.issues[0]?.path.join('.') || 'environment';
    throw new Error(`Invalid environment variables: ${name}`);
  }
  const config = parsed.data;
  const databaseUrl = config.DATABASE_URL; const appOrigin = config.APP_ORIGIN;
  const endpoint = config.APPROVED_SEND_URL; const authorization = config.APPROVED_SEND_TOKEN;

  const authSql = postgres(databaseUrl, { max: 5, prepare: true }); const sql = createPostgresClient(databaseUrl); const scopes = new UserAccountScopeStore(sql);
  const auth = new AuthService({ store: createPostgresAuthStore(authSql), appOrigin, mail: { deliver: () => Promise.resolve() } });
  const sender = endpoint && authorization ? new PrivateApprovedSendHttpProvider({ endpoint, authorization }) : disabledSendProvider;
  const authRoutes = createAuthRoutes(auth, { session: sessionCookie, expired: expiredSessionCookie, read: readSessionToken }, appOrigin);
  const activityRoutes = createActivityRoutes(new ActivityService(new PostgresActivityRepository(sql)));
  const agentRoutes = createAgentRoutes(new AgentService(new PostgresAgentRepository(sql)), { expectedOrigin: appOrigin, apiVersion: 'v1' });
  const draftRoutes = createDraftRoutes(new DraftService(new PostgresDraftRepository(sql), sender, new PostgresDraftSourceReader(sql)), { expectedOrigin: appOrigin });
  const draftList = new PostgresDraftList(sql);
  const attachmentRoutes = createAttachmentRoutes(new AttachmentDeliveryService(new ScopedHypermailAttachmentReader(sql, new HypermailReadClient({ endpoint: config.HYPERMAIL_URL, protocolVersion: config.HYPERMAIL_PROTOCOL_VERSION, headers: { authorization: `Bearer ${config.HYPERMAIL_KEY}` } })), { maxBytes: config.ATTACHMENT_MAX_BYTES, tempDirectory: config.ATTACHMENT_TEMP_DIRECTORY }), { expectedOrigin: appOrigin, apiVersion: 'v1' });
  const subscriptionPersistence = new PostgresNotificationPersistence(sql, new AuthSecretPushSubscriptionCodec(config.PUSH_SUBSCRIPTION_ENCRYPTION_KEY));

  const scopeForRequest = async (cookie: string | null): Promise<Scope | null> => { const token = readSessionToken(cookie); if (!token) return null; const session = await auth.getSession(token); return !session ? null : { subjectId: session.userId, accountIds: await scopes.accountIdsForUser(session.userId), freshAuthAt: session.createdAt.toISOString() }; };
  const authRequest = (request: WebRequest): RouteRequest => ({ method: request.method, origin: request.origin, cookie: request.cookie, remoteAddress: request.remoteAddress, correlationId: request.correlationId, body: request.body });
  const route = async (request: WebRequest): Promise<WebResponse | null> => {
    const authMatch = /^\/api\/v1\/auth\/(bootstrap|login|logout|recovery|reset)$/.exec(request.pathname);
    if (authMatch) { if (authMatch[1] === 'recovery') return { status: 503, body: { error: 'recovery_delivery_unavailable' } }; return authRoutes[authMatch[1] as 'bootstrap' | 'login' | 'logout' | 'reset'](authRequest(request)); }
    if (request.pathname === '/api/v1/session' && request.method === 'GET') { const scope = await scopeForRequest(request.cookie); if (!scope) return { status: 401, body: { error: 'unauthenticated' } }; return { status: 200, body: { userId: scope.subjectId, accounts: await scopes.accountsForUser(scope.subjectId), sendEnabled: Boolean(endpoint && authorization) } }; }
    if (request.pathname === '/api/v1/notifications/vapid-public-key' && request.method === 'GET') return { status: 200, body: { publicKey: config.VAPID_PUBLIC_KEY } };
    if (request.pathname === '/api/v1/notifications/subscribe' || request.pathname === '/api/v1/notifications/unsubscribe') {
      if (request.method !== 'POST' || request.origin !== appOrigin) return { status: 403, body: { error: 'forbidden' } };
      const notificationScope = await scopeForRequest(request.cookie); if (!notificationScope) return { status: 401, body: { error: 'unauthenticated' } };
      const endpointText = request.body['endpoint']; if (typeof endpointText !== 'string' || !endpointText) return { status: 400, body: { error: 'invalid_subscription' } };
      if (request.pathname.endsWith('/unsubscribe')) { await subscriptionPersistence.unsubscribe(endpointText); return { status: 204, body: {} }; }
      const p256dh = request.body['p256dh']; const authKey = request.body['auth'];
      if (typeof p256dh !== 'string' || !p256dh || typeof authKey !== 'string' || !authKey) return { status: 400, body: { error: 'invalid_subscription' } };
      await subscriptionPersistence.upsertSubscription({ userId: notificationScope.subjectId, endpoint: endpointText, p256dh, auth: authKey });
      return { status: 201, body: { status: 'subscribed' } };
    }
    if (request.pathname === '/api/v1/inbox' && request.method === 'GET') { const scope = await scopeForRequest(request.cookie); if (!scope) return { status: 401, body: { error: 'unauthenticated' } }; const result = await sql.query(`SELECT m.id, m.account_id, COALESCE(m.sender->>'name', m.sender->>'address', '') AS sender, COALESCE(m.subject, '') AS subject, COALESCE(m.preview, '') AS preview, m.received_at FROM app.messages m WHERE m.account_id = ANY($1::uuid[]) ORDER BY m.received_at DESC, m.id DESC LIMIT 50`, [scope.accountIds]); return { status: 200, body: { messages: result.rows } }; }
    const message = /^\/api\/v1\/messages\/([^/]+)$/.exec(request.pathname);
    if (message && request.method === 'GET') { const scope = await scopeForRequest(request.cookie); if (!scope) return { status: 401, body: { error: 'unauthenticated' } }; const result = await sql.query(`SELECT m.id, m.account_id, COALESCE(m.sender->>'name', m.sender->>'address', '') AS sender, m.subject, m.preview, m.received_at, COALESCE(b.text_body, m.preview) AS body, COALESCE((SELECT json_agg(json_build_object('id', a.id, 'name', a.filename, 'sizeBytes', a.size_bytes, 'contentType', a.media_type) ORDER BY a.id) FROM app.attachments a WHERE a.message_id = m.id), '[]'::json) AS attachments FROM app.messages m LEFT JOIN app.message_bodies b ON b.message_id = m.id WHERE m.id = $1::uuid AND m.account_id = ANY($2::uuid[])`, [message[1], scope.accountIds]); return result.rows[0] ? { status: 200, body: { message: result.rows[0] } } : { status: 404, body: { error: 'not_found' } }; }
    const attachment = /^\/api\/v1\/accounts\/([^/]+)\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(request.pathname);
    if (attachment) { const result = await attachmentRoutes.download({ method: request.method, auth: await scopeForRequest(request.cookie), origin: request.origin, apiVersion: request.apiVersion, ...(request.signal ? { signal: request.signal } : {}) }, attachment[1] as string, attachment[2] as string, attachment[3] as string); return result; }
    const scope = await scopeForRequest(request.cookie);
    if (request.pathname === '/api/v1/drafts' && request.method === 'GET') return !scope ? { status: 401, body: { error: { code: 'UNAUTHENTICATED' } } } : { status: 200, body: { drafts: await draftList.list(scope) } };
    if (request.pathname === '/api/v1/activities') return activityRoutes.list({ method: request.method, auth: scope, query: request.query, body: request.body });
    const activity = /^\/api\/v1\/activities\/([^/]+)(?:\/(retry|acknowledge))?$/.exec(request.pathname); if (activity?.[1] && !activity[2]) return activityRoutes.detail({ method: request.method, auth: scope, query: request.query, body: request.body }, activity[1]); if (activity?.[1] && activity[2]) return activityRoutes[activity[2] as 'retry' | 'acknowledge']({ method: request.method, auth: scope, query: request.query, body: request.body }, activity[1]);
    if (request.pathname === '/api/v1/agent') return agentRoutes.dashboard({ method: request.method, auth: scope, origin: request.origin, apiVersion: request.apiVersion, body: request.body });
    const agentQuestion = /^\/api\/v1\/agent\/questions\/([^/]+)\/answer$/.exec(request.pathname); if (agentQuestion?.[1]) return agentRoutes.answer({ method: request.method, auth: scope, origin: request.origin, apiVersion: request.apiVersion, body: request.body }, agentQuestion[1]);
    const agentAction = /^\/api\/v1\/agent\/actions\/([^/]+)\/retry$/.exec(request.pathname); if (agentAction?.[1]) return agentRoutes.retry({ method: request.method, auth: scope, origin: request.origin, apiVersion: request.apiVersion, body: request.body }, agentAction[1]);
    if (request.pathname === '/api/v1/agent/autonomy') return agentRoutes.autonomy({ method: request.method, auth: scope, origin: request.origin, apiVersion: request.apiVersion, body: request.body });
    const draft = /^\/api\/v1\/drafts\/(?:([^/]+)(?:\/(history|approval))?|approvals\/([^/]+)\/send)$/.exec(request.pathname); if (request.pathname === '/api/v1/drafts') return draftRoutes.create({ method: request.method, auth: scope, origin: request.origin, body: request.body }); if (request.pathname === '/api/v1/drafts/reply') return draftRoutes.reply({ method: request.method, auth: scope, origin: request.origin, body: request.body }); if (draft?.[1] && !draft[2]) return draftRoutes.save({ method: request.method, auth: scope, origin: request.origin, body: request.body }, draft[1]); if (draft?.[2] === 'history' && draft[1]) return draftRoutes.history({ method: request.method, auth: scope, origin: request.origin, body: request.body }, draft[1]); if (draft?.[2] === 'approval' && draft[1]) return draftRoutes.beginApproval({ method: request.method, auth: scope, origin: request.origin, body: request.body }, draft[1]); if (draft?.[3]) return endpoint && authorization ? draftRoutes.confirmSend({ method: request.method, auth: scope, origin: request.origin, body: request.body }, draft[3]) : { status: 503, body: { error: { code: 'SEND_DISABLED', message: 'Approved send is not configured.' } } };
    return null;
  };
  return { dispatch: route, close: async () => { await Promise.all([sql.close(), authSql.end({ timeout: 5 })]); } };
}
