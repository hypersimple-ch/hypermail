import postgres from 'postgres';
import { AuthService, createPostgresAuthStore, expiredSessionCookie, readSessionToken, sessionCookie, SmtpRecoveryDelivery, RecoveryDeliveryScheduler, purgeExpiredRecoveryPayloads } from '@hypermail/auth';
import { webEnvSchema } from '@hypermail/contracts';
import { ConversationStore, createPostgresClient, UserAccountScopeStore } from '@hypermail/db';
import { HypermailReadClient, createTenantHypermailSessionProvider, parseTenantHypermailRoutes, TenantHypermailRouteResolver } from '@hypermail/hypermail';
import type { Json } from '@hypermail/hypermail';
import { PostgresNotificationPersistence, PushSubscriptionAesCodec } from '@hypermail/notifications';
import { IntegratedApprovedSendProvider, type MailSendProvider } from '@hypermail/send';
import { HypermailApprovedSendTransport } from '@hypermail/hypermail/approved-send';
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
import { createMailboxRoutes } from './mailboxes/routes.js';
import { MailboxService } from './mailboxes/service.js';
import { AuthSecretPushSubscriptionCodec } from './notifications/crypto-codec.js';
import type { Readable } from 'node:stream';
import { PostgresOAuthService } from './oauth/service.js';
import { createOAuthRoutes } from './oauth/routes.js';
import { PostgresOwnerSendRequestRepository, OwnerSendRequestService, createOwnerSendRequestRoutes } from './send-requests/index.js';
import { AgentConnectionsService, PostgresAgentConnectionsRepository, createAgentConnectionRoutes } from './agent-connections/index.js';
import { ConversationService } from './conversations/service.js';
import { createConversationRoutes } from './conversations/routes.js';
import { MailboxPageReader, MailReadError, type MailReadProvider } from './mailbox-page.js';
import { MessageReader } from './message-reader.js';
import { createMailReadRoutes } from './mail-read-routes.js';
import { createPublicMcpHttpHandler, PostgresMcpMutationJournal, PostgresOwnerSendApprovalRequests, PostgresPublicMcpAuthorization, PublicMcpError, PublicMcpFacadeCore, TenantDraftServiceAdapter, TenantRoutedMailboxAdapter, type PublicMcpHttpHandler, type PublicFacadePorts } from './mcp/index.js';

export type WebRequest = Readonly<{ method: string; pathname: string; query: Readonly<Record<string, string | undefined>>; origin: string | null; cookie: string | null; remoteAddress: string; correlationId: string; apiVersion: string | null; contentType?: string | null; body: Readonly<Record<string, unknown>>; signal?: AbortSignal }>;
export type WebResponse = Readonly<{ status: number; body?: Readonly<Record<string, unknown>>; setCookie?: string; headers?: Readonly<Record<string, string>>; stream?: Readable; cleanup?: () => Promise<void> }>;
export interface WebRuntime { dispatch(request: WebRequest): Promise<WebResponse | null>; close(): Promise<void>; readonly publicMcp?: PublicMcpHttpHandler; readonly trustedProxyCidrs?: readonly string[]; }
type Scope = Readonly<{ subjectId: string; ownerEmail: string; accountIds: readonly string[]; freshAuthAt?: string; sessionId?: string }>;

const webEnvironmentNames = [
  'NODE_ENV', 'DATABASE_URL', 'APP_ORIGIN', 'AUTH_SECRET', 'OAUTH_TOKEN_HASH_KEY', 'TRUSTED_PROXY_CIDRS', 'HYPERMAIL_URL',
  'HYPERMAIL_KEY', 'HYPERMAIL_PROTOCOL_VERSION', 'HYPERMAIL_TENANT_ROUTES', 'VAPID_SUBJECT', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY',
  'PUSH_SUBSCRIPTION_ENCRYPTION_KEY', 'ATTACHMENT_TEMP_DIRECTORY', 'ATTACHMENT_MAX_BYTES', 'ATTACHMENT_ORPHAN_MAX_AGE_SECONDS',
  'RECOVERY_SMTP_HOST', 'RECOVERY_SMTP_PORT', 'RECOVERY_SMTP_SECURE', 'RECOVERY_SMTP_USER', 'RECOVERY_SMTP_PASSWORD', 'RECOVERY_FROM',
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
  const tenantRoutes = config.HYPERMAIL_TENANT_ROUTES ? parseTenantHypermailRoutes(config.HYPERMAIL_TENANT_ROUTES) : undefined;
  const tenantResolver = tenantRoutes ? new TenantHypermailRouteResolver(tenantRoutes) : undefined;
  const developmentHypermail = !tenantRoutes && config.NODE_ENV === 'development'
    ? new HypermailReadClient({ endpoint: config.HYPERMAIL_URL, protocolVersion: config.HYPERMAIL_PROTOCOL_VERSION, headers: { authorization: `Bearer ${config.HYPERMAIL_KEY}` } })
    : undefined;
  const sessionCookieOptions = { insecureLocalDevelopment: config.NODE_ENV === 'development' && new URL(appOrigin).protocol === 'http:' } as const;

  const authSql = postgres(databaseUrl, { max: 5, prepare: true }); const sql = createPostgresClient(databaseUrl); const scopes = new UserAccountScopeStore(sql);
  const oauth = new PostgresOAuthService(authSql, appOrigin, config.OAUTH_TOKEN_HASH_KEY);
  const oauthRoutes = createOAuthRoutes(oauth, appOrigin);
  const tenantSessions = tenantRoutes ? createTenantHypermailSessionProvider({ routes: tenantRoutes, configVersion: 'environment', protocolVersion: config.HYPERMAIL_PROTOCOL_VERSION }) : undefined;
  let developmentInitialization: Promise<Json> | undefined;
  const initializeDevelopmentHypermail = (): Promise<Json> => {
    if (!developmentHypermail) return Promise.reject(new MailReadError(503, 'PROVIDER_UNAVAILABLE'));
    developmentInitialization ??= developmentHypermail.initialize().catch((error: unknown) => { developmentInitialization = undefined; throw error; });
    return developmentInitialization;
  };
  const mailReadProvider: MailReadProvider = {
    async withRead<T>(userId: string, operation: (read: HypermailReadClient) => Promise<T>): Promise<T> {
      if (tenantSessions) {
        const lease = await tenantSessions.leaseForUser(userId);
        try { return await operation(lease.bundle.read); } finally { await lease.release(); }
      }
      if (!developmentHypermail) throw new MailReadError(503, 'PROVIDER_UNAVAILABLE');
      await initializeDevelopmentHypermail();
      return operation(developmentHypermail);
    },
  };
  const messageReader = new MessageReader(sql, mailReadProvider);
  const mailReadRoutes = createMailReadRoutes(new MailboxPageReader(sql, mailReadProvider, config.AUTH_SECRET), messageReader);
  const sourceReader = new PostgresDraftSourceReader(messageReader);
  const tenantApprovedSenders = new Map<string, MailSendProvider>();
  const sender = { providerForUser(userId: string): MailSendProvider {
    if (!tenantSessions || !tenantResolver) throw new Error('HYPERMAIL_TENANT_ROUTE_REQUIRED');
    tenantResolver.routeForUser(userId);
    let provider = tenantApprovedSenders.get(userId);
    if (!provider) {
      provider = new IntegratedApprovedSendProvider(sql, userId, new HypermailApprovedSendTransport({ callTool: (name, args) => tenantSessions.withSessionForUser(userId, bundle => bundle.read.transport.call(name, args)) }));
      tenantApprovedSenders.set(userId, provider);
    }
    return provider;
  } };
  const draftService = new DraftService(new PostgresDraftRepository(sql), sender, sourceReader);
  const unavailable = <Result>(): Promise<Result> => Promise.reject(new PublicMcpError('temporarily_unavailable'));
  const deniedPorts: PublicFacadePorts = { authorizer:{authorize:()=>Promise.reject(new PublicMcpError('forbidden'))},fence:{stillCurrent:()=>Promise.resolve(false)},mailbox:{list:unavailable,search:unavailable,read:unavailable,readAttachment:unavailable,listFolders:unavailable,archive:unavailable,trashRecoverable:unavailable,move:unavailable,markRead:unavailable,markUnread:unavailable},drafts:{create:unavailable,edit:unavailable},sendRequests:{requestPending:unavailable} };
  let publicPorts=deniedPorts;
  if (tenantSessions) {
    const authorization=new PostgresPublicMcpAuthorization(authSql,new URL('/mcp',appOrigin).toString());
    const journal=new PostgresMcpMutationJournal(authSql);
    const mailbox=new TenantRoutedMailboxAdapter(authSql,tenantSessions,(a,c)=>authorization.stillCurrentAuthority(a,c),{tempDirectory:config.ATTACHMENT_TEMP_DIRECTORY,maxBytes:Math.min(config.ATTACHMENT_MAX_BYTES,25_000_000)},journal);
    publicPorts={authorizer:authorization,fence:authorization,mailbox,drafts:new TenantDraftServiceAdapter(draftService,(a,c)=>authorization.stillCurrentAuthority(a,c),journal),sendRequests:new PostgresOwnerSendApprovalRequests(authSql,(a,c)=>authorization.stillCurrentAuthority(a,c))};
  }
  const publicMcp = createPublicMcpHttpHandler({ oauth, facade: new PublicMcpFacadeCore(publicPorts), origin: appOrigin, trustedProxyCidrs: config.TRUSTED_PROXY_CIDRS, audit: async event => {
    await authSql`insert into app.audits(actor_type,actor_id,event,correlation_id,metadata) values('system',${event.userId ?? null},${event.event},'mcp',${JSON.stringify({ reason: event.reason ?? null, session: event.sessionId ? 'present' : 'absent' })}::jsonb)`;
  } });
  const recoveryCodec = new PushSubscriptionAesCodec(config.PUSH_SUBSCRIPTION_ENCRYPTION_KEY);
  const auth = new AuthService({ store: createPostgresAuthStore(authSql, recoveryCodec), appOrigin });
  const smtp = config.RECOVERY_SMTP_HOST && config.RECOVERY_FROM ? new SmtpRecoveryDelivery({
    host: config.RECOVERY_SMTP_HOST, port: config.RECOVERY_SMTP_PORT, secure: config.RECOVERY_SMTP_SECURE, from: config.RECOVERY_FROM,
    ...(config.RECOVERY_SMTP_USER ? { user: config.RECOVERY_SMTP_USER } : {}), ...(config.RECOVERY_SMTP_PASSWORD ? { password: config.RECOVERY_SMTP_PASSWORD } : {}),
    localDevelopment: config.NODE_ENV === 'development',
  }) : undefined;
  const recoveryScheduler = smtp ? new RecoveryDeliveryScheduler(authSql, recoveryCodec, smtp) : undefined;
  recoveryScheduler?.start();
  let recoveryReadiness: 'ready' | 'degraded' = 'degraded';
  if (smtp) void smtp.ready().then(ready => { recoveryReadiness = ready ? 'ready' : 'degraded'; });
  let recoveryPurge: Promise<void> | undefined;
  const purgeRecovery = (): void => { if (!recoveryPurge) recoveryPurge = purgeExpiredRecoveryPayloads(authSql).catch(() => undefined).finally(() => { recoveryPurge = undefined; }); };
  const recoveryPurgeTimer = !recoveryScheduler ? setInterval(purgeRecovery, 60_000) : undefined;
  recoveryPurgeTimer?.unref();
  if (!recoveryScheduler) purgeRecovery();
  const authRoutes = createAuthRoutes(auth, {
    session: (token) => sessionCookie(token, sessionCookieOptions),
    expired: () => expiredSessionCookie(sessionCookieOptions),
    read: (cookie) => readSessionToken(cookie, sessionCookieOptions),
  }, appOrigin);
  const activityRoutes = createActivityRoutes(new ActivityService(new PostgresActivityRepository(sql)));
  const managerRoutes = createAgentConnectionRoutes(new AgentConnectionsService(new PostgresAgentConnectionsRepository(sql)), appOrigin);
  const agentRoutes = createAgentRoutes(new AgentService(new PostgresAgentRepository(sql)), { expectedOrigin: appOrigin, apiVersion: 'v1' });
  const conversationRoutes = createConversationRoutes(new ConversationService(new ConversationStore(sql)), { expectedOrigin: appOrigin });
  const draftRoutes = createDraftRoutes(new DraftService(new PostgresDraftRepository(sql), sender, sourceReader), { expectedOrigin: appOrigin });
  const sendRequestRoutes = createOwnerSendRequestRoutes(new OwnerSendRequestService(new PostgresOwnerSendRequestRepository(authSql), sender), appOrigin);
  const draftList = new PostgresDraftList(sql);
  const unavailableReadClient = { initialize: () => Promise.reject(new Error('HYPERMAIL_TENANT_ROUTE_REQUIRED')), openAttachment: () => Promise.reject(new Error('HYPERMAIL_TENANT_ROUTE_REQUIRED')) } as unknown as HypermailReadClient;
  const attachmentClient = developmentHypermail ? { initialize: initializeDevelopmentHypermail, openAttachment: developmentHypermail.openAttachment.bind(developmentHypermail) } : unavailableReadClient;
  const attachmentReader = new ScopedHypermailAttachmentReader(sql, tenantSessions ?? attachmentClient);
  const attachmentRoutes = createAttachmentRoutes(new AttachmentDeliveryService(attachmentReader, { maxBytes: config.ATTACHMENT_MAX_BYTES, tempDirectory: config.ATTACHMENT_TEMP_DIRECTORY }), { expectedOrigin: appOrigin, apiVersion: 'v1' });
  const onboardingProvider = tenantSessions ? { leaseForUser: async (userId: string) => { const lease = await tenantSessions.leaseForUser(userId); return { provider: lease.bundle.read, release: () => lease.release() }; } }
    : developmentHypermail ? { initialize: initializeDevelopmentHypermail, addAccount: developmentHypermail.addAccount.bind(developmentHypermail), completeAddAccount: developmentHypermail.completeAddAccount.bind(developmentHypermail) }
    : { initialize: unavailableReadClient.initialize.bind(unavailableReadClient), addAccount: () => Promise.reject(new Error('HYPERMAIL_TENANT_ROUTE_REQUIRED')), completeAddAccount: () => Promise.reject(new Error('HYPERMAIL_TENANT_ROUTE_REQUIRED')) };
  const mailboxRoutes = createMailboxRoutes(new MailboxService(onboardingProvider, scopes), { expectedOrigin: appOrigin });
  const subscriptionPersistence = new PostgresNotificationPersistence(sql, new AuthSecretPushSubscriptionCodec(config.PUSH_SUBSCRIPTION_ENCRYPTION_KEY));
  const scopeForRequest = async (cookie: string | null): Promise<Scope | null> => { const token = readSessionToken(cookie, sessionCookieOptions); if (!token) return null; const identity = await auth.getAuthenticatedSession(token); return !identity ? null : { subjectId: identity.user.id, ownerEmail: identity.user.email, accountIds: await scopes.accountIdsForUser(identity.user.id), freshAuthAt: identity.session.createdAt.toISOString(), sessionId: identity.session.id }; };
  const authRequest = (request: WebRequest): RouteRequest => ({ method: request.method, origin: request.origin, cookie: request.cookie, remoteAddress: request.remoteAddress, correlationId: request.correlationId, body: request.body });
  const route = async (request: WebRequest): Promise<WebResponse | null> => {
    if (request.pathname === '/.well-known/oauth-authorization-server' && request.method === 'GET') return oauthRoutes.metadata();
    if ((request.pathname === '/.well-known/oauth-protected-resource' || request.pathname === '/.well-known/oauth-protected-resource/mcp') && request.method === 'GET') return { status: 200, body: { resource: new URL('/mcp', appOrigin).toString(), authorization_servers: [appOrigin], scopes_supported: ['agent:mailbox'], bearer_methods_supported: ['header'] }, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } };
    if (request.pathname === '/oauth/authorize') { if(!['GET','POST'].includes(request.method))return {status:405,headers:{Allow:'GET, POST','Cache-Control':'no-store'}}; const scope=await scopeForRequest(request.cookie); const oauthRequest={ method:request.method, query:request.query, origin:request.origin, body:request.body, userId:scope?.subjectId??null }; return request.method==='GET'?oauthRoutes.authorizeGet(oauthRequest):oauthRoutes.authorizePost(oauthRequest); }
    if (request.pathname === '/oauth/token') { if(request.method!=='POST')return {status:405,headers:{Allow:'POST','Cache-Control':'no-store'}}; if(request.contentType !== 'application/x-www-form-urlencoded') return {status:415,body:{error:'invalid_request'},headers:{'Cache-Control':'no-store',Pragma:'no-cache'}}; return oauthRoutes.token({ method:request.method,query:request.query,origin:request.origin,body:request.body,userId:null }); }
    if (request.pathname === '/oauth/revoke') { if(request.method!=='POST')return {status:405,headers:{Allow:'POST','Cache-Control':'no-store'}}; if(request.contentType !== 'application/x-www-form-urlencoded') return {status:415,body:{error:'invalid_request'},headers:{'Cache-Control':'no-store',Pragma:'no-cache'}}; return oauthRoutes.revoke({ method:request.method,query:request.query,origin:request.origin,body:request.body,userId:null }); }
    const authMatch = /^\/(?:api\/v1\/)?auth\/(bootstrap|login|logout|password|recovery|reset|reauthenticate)$/.exec(request.pathname);
    if (authMatch) return authRoutes[authMatch[1] as keyof typeof authRoutes](authRequest(request));
    if (request.pathname === '/api/v1/session' && request.method === 'GET') {
      const scope = await scopeForRequest(request.cookie);
      if (!scope) return { status: 401, body: { error: 'unauthenticated', bootstrapAvailable: await auth.bootstrapAvailable() } };
      let sendEnabled = false;
      try { if (tenantResolver) { tenantResolver.routeForUser(scope.subjectId); sendEnabled = true; } } catch { /* Missing routes cannot send. */ }
      return { status: 200, body: { userId: scope.subjectId, user: { id: scope.subjectId, email: scope.ownerEmail }, accounts: await scopes.accountsForUser(scope.subjectId), sendEnabled, recovery: recoveryReadiness } };
    }
    if (request.pathname === '/api/v1/mailboxes' || request.pathname === '/api/v1/mailboxes/complete') {
      const scope = request.method === 'POST' && request.origin === appOrigin ? await scopeForRequest(request.cookie) : null;
      const mailboxRequest = { method: request.method, origin: request.origin, auth: scope, body: request.body };
      return request.pathname.endsWith('/complete') ? mailboxRoutes.complete(mailboxRequest) : mailboxRoutes.start(mailboxRequest);
    }
    if (request.pathname === '/api/v1/notifications/vapid-public-key' && request.method === 'GET') return { status: 200, body: { publicKey: config.VAPID_PUBLIC_KEY } };
    const activate = /^\/api\/v1\/mailboxes\/([^/]+)\/assistant\/activate$/.exec(request.pathname);
    if (activate?.[1]) return managerRoutes.activateAssistant({ method: request.method, auth: await scopeForRequest(request.cookie), origin: request.origin, body: request.body }, activate[1]);
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
    if (request.pathname === '/api/v1/inbox' && request.method === 'GET') return mailReadRoutes.inbox({ auth: await scopeForRequest(request.cookie), query: request.query });
    const messageActivities = /^\/api\/v1\/messages\/([^/]+)\/activities$/.exec(request.pathname); if (messageActivities?.[1]) return activityRoutes.forMessage({ method:request.method,auth:await scopeForRequest(request.cookie),query:request.query,body:request.body },messageActivities[1]);
    const message = /^\/api\/v1\/messages\/([^/]+)$/.exec(request.pathname);
    if (message?.[1] && request.method === 'GET') return mailReadRoutes.message({ auth: await scopeForRequest(request.cookie), query: request.query }, message[1]);
    const attachment = /^\/api\/v1\/accounts\/([^/]+)\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(request.pathname);
    if (attachment) { const result = await attachmentRoutes.download({ method: request.method, auth: await scopeForRequest(request.cookie), origin: request.origin, apiVersion: request.apiVersion, ...(request.signal ? { signal: request.signal } : {}) }, attachment[1] as string, attachment[2] as string, attachment[3] as string); return result; }
    const scope = await scopeForRequest(request.cookie);
    if (request.pathname === '/api/v1/drafts' && request.method === 'GET') return !scope ? { status: 401, body: { error: { code: 'UNAUTHENTICATED' } } } : { status: 200, body: { drafts: await draftList.list(scope) } };
    const conversationRequest = { method: request.method, auth: scope, origin: request.origin, query: request.query, body: request.body };
    if (request.pathname === '/api/v1/conversations') return request.method === 'POST' ? conversationRoutes.create(conversationRequest) : conversationRoutes.list(conversationRequest);
    const conversationMessages = /^\/api\/v1\/conversations\/([^/]+)\/messages$/.exec(request.pathname);
    if (conversationMessages?.[1]) return request.method === 'POST' ? conversationRoutes.post(conversationRequest, conversationMessages[1]) : conversationRoutes.messages(conversationRequest, conversationMessages[1]);
    const conversationRetry = /^\/api\/v1\/conversations\/([^/]+)\/turns\/([^/]+)\/retry$/.exec(request.pathname);
    if (conversationRetry?.[1] && conversationRetry[2]) return conversationRoutes.retry(conversationRequest, conversationRetry[1], conversationRetry[2]);
    const managerRequest = { method: request.method, origin: request.origin, auth: scope, body: request.body };
    if (request.pathname === '/api/v1/agent-connections') return managerRoutes.read(managerRequest);
    if (request.pathname === '/api/v1/mailbox-managers/default') return managerRoutes.setDefault(managerRequest);
    const connectionSetting = /^\/api\/v1\/agent-connections\/([^/]+)\/(lifecycle|security-revoke)$/.exec(request.pathname);
    if (connectionSetting?.[1]) return connectionSetting[2] === 'security-revoke' ? managerRoutes.securityRevoke(managerRequest, connectionSetting[1]) : managerRoutes.lifecycle(managerRequest, connectionSetting[1]);
    const mailboxManager = /^\/api\/v1\/mailbox-managers\/([^/]+)\/(assignment|reapprove)$/.exec(request.pathname);
    if (mailboxManager?.[1]) return mailboxManager[2] === 'reapprove' ? managerRoutes.reapprove(managerRequest, mailboxManager[1]) : managerRoutes.assignment(managerRequest, mailboxManager[1]);
    if (request.pathname === '/api/v1/activities') return activityRoutes.list({ method: request.method, auth: scope, query: request.query, body: request.body });
    const activity = /^\/api\/v1\/activities\/([^/]+)(?:\/(retry|acknowledge))?$/.exec(request.pathname); if (activity?.[1] && !activity[2]) return activityRoutes.detail({ method: request.method, auth: scope, query: request.query, body: request.body }, activity[1]); if (activity?.[1] && activity[2]) return activityRoutes[activity[2] as 'retry' | 'acknowledge']({ method: request.method, auth: scope, query: request.query, body: request.body }, activity[1]);
    if (request.pathname === '/api/v1/agent') return agentRoutes.dashboard({ method: request.method, auth: scope, origin: request.origin, apiVersion: request.apiVersion, body: request.body });
    const proposalRequest = { method: request.method, auth: scope, origin: request.origin, apiVersion: request.apiVersion, query: request.query, body: request.body };
    if (request.pathname === '/api/v1/agent/proposals') return agentRoutes.proposals(proposalRequest);
    if (request.pathname === '/api/v1/agent/folders') return agentRoutes.folders(proposalRequest);
    const proposalReview = /^\/api\/v1\/agent\/proposals\/([^/]+)\/review$/.exec(request.pathname);
    if (proposalReview?.[1]) return agentRoutes.review(proposalRequest, proposalReview[1]);
    const agentQuestion = /^\/api\/v1\/agent\/questions\/([^/]+)\/answer$/.exec(request.pathname); if (agentQuestion?.[1]) return agentRoutes.answer({ method: request.method, auth: scope, origin: request.origin, apiVersion: request.apiVersion, body: request.body }, agentQuestion[1]);
    const agentAction = /^\/api\/v1\/agent\/actions\/([^/]+)\/retry$/.exec(request.pathname); if (agentAction?.[1]) return agentRoutes.retry({ method: request.method, auth: scope, origin: request.origin, apiVersion: request.apiVersion, body: request.body }, agentAction[1]);
    if (request.pathname === '/api/v1/agent/autonomy') return agentRoutes.autonomy({ method: request.method, auth: scope, origin: request.origin, apiVersion: request.apiVersion, body: request.body });
    const ownerRequest = { method: request.method, auth: scope, origin: request.origin, body: request.body };
    if (request.pathname === '/api/v1/send-requests') return sendRequestRoutes.list(ownerRequest);
    const sendRequest = /^\/api\/v1\/send-requests\/([^/]+)(?:\/(reject|approval|reconcile|manual-send-review)|\/approvals\/([^/]+)\/confirm)?$/.exec(request.pathname);
    if (sendRequest?.[1]) {
      if (!sendRequest[2] && !sendRequest[3]) return sendRequestRoutes.detail(ownerRequest, sendRequest[1]);
      if (sendRequest[2] === 'reject') return sendRequestRoutes.reject(ownerRequest, sendRequest[1]);
      if (sendRequest[2] === 'approval') return sendRequestRoutes.begin(ownerRequest, sendRequest[1]);
      if (sendRequest[2] === 'reconcile') return sendRequestRoutes.reconcile(ownerRequest, sendRequest[1]);
      if (sendRequest[2] === 'manual-send-review') return sendRequestRoutes.manualReview(ownerRequest, sendRequest[1]);
      if (sendRequest[3]) return sendRequestRoutes.confirm(ownerRequest, sendRequest[1], sendRequest[3]);
    }
    if (request.pathname === '/api/v1/drafts') return draftRoutes.create(ownerRequest);
    if (request.pathname === '/api/v1/drafts/reply') return draftRoutes.reply(ownerRequest);
    const draft = /^\/api\/v1\/drafts\/(?:([^/]+)(?:\/(history|approval|reconcile|manual-send-review))?|approvals\/([^/]+)\/send)$/.exec(request.pathname);
    if (draft?.[1] && !draft[2]) return request.method === 'GET' ? draftRoutes.detail(ownerRequest, draft[1]) : draftRoutes.save(ownerRequest, draft[1]);
    if (draft?.[1] && draft[2] === 'history') return draftRoutes.history(ownerRequest, draft[1]);
    if (draft?.[1] && draft[2] === 'approval') return draftRoutes.beginApproval(ownerRequest, draft[1]);
    if (draft?.[1] && draft[2] === 'reconcile') return draftRoutes.reconcile(ownerRequest, draft[1]);
    if (draft?.[1] && draft[2] === 'manual-send-review') return draftRoutes.manualReview(ownerRequest, draft[1]);
    if (draft?.[3]) return draftRoutes.confirmSend(ownerRequest, draft[3]);
    return null;
  };
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    clearInterval(recoveryPurgeTimer);
    let databaseClosing: Promise<void> | undefined;
    const closeDatabases = (): Promise<void> => databaseClosing ??= Promise.all([sql.close(), authSql.end({ timeout: 5 })]).then(() => undefined);
    // Leave current SMTP/provider work a grace window, but never wait forever on a
    // disconnected PostgreSQL query. Five-second pool closure fits the host's45s stop.
    const deadline = setTimeout(() => { void closeDatabases().catch(() => undefined); }, 35_000);
    try {
      await Promise.all([recoveryScheduler?.stop(), recoveryPurge, publicMcp.close(), tenantSessions?.close(), developmentHypermail?.transport.close()]);
    } finally {
      clearTimeout(deadline);
      await closeDatabases();
    }
  })();
  return { dispatch: route, publicMcp, trustedProxyCidrs: config.TRUSTED_PROXY_CIDRS, close };
}
