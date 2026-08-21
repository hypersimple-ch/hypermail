import { HypermailPolicyClient, HypermailReadClient } from "./client.js";

export interface TenantHypermailRoute {
  readonly endpoint: string;
  readonly key: string;
  readonly protocolVersion?: string;
  /** Optional tenant-private exactly-once send bridge. It is never inherited from another tenant. */
  readonly approvedSendEndpoint?: string;
  readonly approvedSendToken?: string;
}

export type TenantHypermailRouteMap = ReadonlyMap<string, TenantHypermailRoute>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const own = (value: object, property: string): boolean => Object.prototype.hasOwnProperty.call(value, property);

function tenantId(value: string): string {
  if (typeof value !== "string" || !uuid.test(value)) throw new Error("HYPERMAIL_INVALID_TENANT_USER_ID");
  return value.toLowerCase();
}

function routeEndpoint(value: unknown): string {
  if (typeof value !== "string") throw new Error("HYPERMAIL_TENANT_ROUTES_INVALID");
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new Error();
    return url.href;
  } catch { throw new Error("HYPERMAIL_TENANT_ROUTES_INVALID"); }
}

/** Parses the deployment-supplied routing table without ever including its values in errors. */
export function parseTenantHypermailRoutes(raw: string): TenantHypermailRouteMap {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("HYPERMAIL_TENANT_ROUTES_INVALID"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("HYPERMAIL_TENANT_ROUTES_INVALID");
  const routes = new Map<string, TenantHypermailRoute>();
  const endpoints = new Set<string>();
  for (const [untrustedUserId, untrustedRoute] of Object.entries(value)) {
    const userId = tenantId(untrustedUserId);
    if (routes.has(userId) || typeof untrustedRoute !== "object" || untrustedRoute === null || Array.isArray(untrustedRoute)) throw new Error("HYPERMAIL_TENANT_ROUTES_INVALID");
    const candidate = untrustedRoute as Record<string, unknown>;
    const fields = Object.keys(candidate);
    const allowed = new Set(["endpoint", "key", "protocolVersion", "approvedSendEndpoint", "approvedSendToken"]);
    if (fields.some((field) => !allowed.has(field)) || !own(candidate, "endpoint") || !own(candidate, "key")) throw new Error("HYPERMAIL_TENANT_ROUTES_INVALID");
    const endpoint = routeEndpoint(candidate["endpoint"]);
    if (endpoints.has(endpoint)) throw new Error("HYPERMAIL_TENANT_ENDPOINT_REUSED");
    if (typeof candidate["key"] !== "string" || candidate["key"].trim().length === 0) throw new Error("HYPERMAIL_TENANT_ROUTES_INVALID");
    if (candidate["protocolVersion"] !== undefined && (typeof candidate["protocolVersion"] !== "string" || candidate["protocolVersion"].trim().length === 0)) throw new Error("HYPERMAIL_TENANT_ROUTES_INVALID");
    const hasApprovedEndpoint = candidate["approvedSendEndpoint"] !== undefined;
    const hasApprovedToken = candidate["approvedSendToken"] !== undefined;
    if (hasApprovedEndpoint !== hasApprovedToken) throw new Error("HYPERMAIL_TENANT_ROUTES_INVALID");
    const approvedSendEndpoint = hasApprovedEndpoint ? routeEndpoint(candidate["approvedSendEndpoint"]) : undefined;
    if (approvedSendEndpoint && !approvedSendEndpoint.startsWith("https://")) throw new Error("HYPERMAIL_TENANT_ROUTES_INVALID");
    if (hasApprovedToken && (typeof candidate["approvedSendToken"] !== "string" || candidate["approvedSendToken"].trim().length < 16)) throw new Error("HYPERMAIL_TENANT_ROUTES_INVALID");
    const route: TenantHypermailRoute = { endpoint, key: candidate["key"], ...(candidate["protocolVersion"] === undefined ? {} : { protocolVersion: candidate["protocolVersion"] }), ...(approvedSendEndpoint ? { approvedSendEndpoint, approvedSendToken: candidate["approvedSendToken"] as string } : {}) };
    endpoints.add(endpoint); routes.set(userId, Object.freeze(route));
  }
  return routes;
}

export class TenantHypermailRouteResolver {
  constructor(readonly routes: TenantHypermailRouteMap) {}
  routeForUser(userId: string): TenantHypermailRoute {
    const route = this.routes.get(tenantId(userId));
    if (!route) throw new Error("HYPERMAIL_TENANT_ROUTE_MISSING");
    return route;
  }
}

export interface TenantHypermailClientBundle {
  readonly read: HypermailReadClient;
  readonly policy: HypermailPolicyClient;
  close?(signal?: AbortSignal): void | Promise<void>;
}
export type TenantHypermailSessionFactory<Bundle extends TenantHypermailClientBundle = TenantHypermailClientBundle> = (route: TenantHypermailRoute, signal?: AbortSignal) => Promise<Bundle>;
export interface TenantHypermailSessionProviderOptions<Bundle extends TenantHypermailClientBundle = TenantHypermailClientBundle> {
  routes: TenantHypermailRouteMap;
  configVersion: string;
  createSession: TenantHypermailSessionFactory<Bundle>;
  maxSessions?: number;
  idleTimeoutMs?: number;
  initializeTimeoutMs?: number;
  closeTimeoutMs?: number;
  now?: () => number;
}
export interface TenantHypermailSessionLease<Bundle extends TenantHypermailClientBundle = TenantHypermailClientBundle> {
  readonly bundle: Bundle;
  release(): Promise<void>;
}
type Entry<Bundle> = { promise: Promise<Bundle>; lastUsed: number; version: string; references: number; retiring: boolean; controller: AbortController; closing?: Promise<void>; bundle?: Bundle; bundleClose?: Promise<void> };

/** Owns bounded stateful sessions. Callers must hold a lease for the full provider operation. */
export class TenantHypermailSessionProvider<Bundle extends TenantHypermailClientBundle = TenantHypermailClientBundle> {
  #resolver: TenantHypermailRouteResolver;
  #version: string;
  readonly #entries = new Map<string, Entry<Bundle>>();
  readonly #factory: TenantHypermailSessionFactory<Bundle>;
  readonly #maximum: number;
  readonly #idle: number;
  readonly #initializeTimeout: number;
  readonly #closeTimeout: number;
  readonly #now: () => number;
  #closed = false;
  #mutation: Promise<void> = Promise.resolve();
  readonly #compatibilityLeases = new Map<string, TenantHypermailSessionLease<Bundle>>();

  constructor(options: TenantHypermailSessionProviderOptions<Bundle>) {
    if (!Number.isSafeInteger(options.maxSessions ?? 100) || (options.maxSessions ?? 100) < 1) throw new RangeError("maxSessions must be a positive integer");
    if (!Number.isFinite(options.idleTimeoutMs ?? 15 * 60_000) || (options.idleTimeoutMs ?? 15 * 60_000) < 1) throw new RangeError("idleTimeoutMs must be positive");
    if (!Number.isFinite(options.initializeTimeoutMs ?? 15_000) || (options.initializeTimeoutMs ?? 15_000) < 1) throw new RangeError("initializeTimeoutMs must be positive");
    if (!Number.isFinite(options.closeTimeoutMs ?? 5_000) || (options.closeTimeoutMs ?? 5_000) < 1) throw new RangeError("closeTimeoutMs must be positive");
    if (!options.configVersion) throw new Error("HYPERMAIL_TENANT_CONFIG_VERSION_REQUIRED");
    this.#resolver = new TenantHypermailRouteResolver(options.routes); this.#version = options.configVersion;
    this.#factory = options.createSession; this.#maximum = options.maxSessions ?? 100; this.#idle = options.idleTimeoutMs ?? 15 * 60_000;
    this.#initializeTimeout = options.initializeTimeoutMs ?? 15_000; this.#closeTimeout = options.closeTimeoutMs ?? 5_000; this.#now = options.now ?? Date.now;
  }

  async leaseForUser(userId: string): Promise<TenantHypermailSessionLease<Bundle>> {
    const normalized = tenantId(userId); let entry!: Entry<Bundle>; const close: Entry<Bundle>[] = [];
    await this.#locked(() => {
      if (this.#closed) throw new Error("HYPERMAIL_TENANT_SESSION_PROVIDER_CLOSED");
      const route = this.#resolver.routeForUser(normalized); const now = this.#now();
      for (const [id, candidate] of this.#entries) if (candidate.references === 0 && now - candidate.lastUsed >= this.#idle) { this.#entries.delete(id); candidate.retiring = true; close.push(candidate); }
      const existing = this.#entries.get(normalized);
      if (existing && existing.version === this.#version && !existing.retiring) entry = existing;
      else {
        if (existing) { this.#entries.delete(normalized); existing.retiring = true; if (existing.references === 0) close.push(existing); }
        if (this.#entries.size >= this.#maximum) {
          const available = [...this.#entries.entries()].filter(([, candidate]) => candidate.references === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
          if (!available) throw new Error("HYPERMAIL_TENANT_SESSION_CAPACITY_EXHAUSTED");
          this.#entries.delete(available[0]); available[1].retiring = true; close.push(available[1]);
        }
        const controller = new AbortController();
        entry = { promise: undefined as unknown as Promise<Bundle>, lastUsed: now, version: this.#version, references: 0, retiring: false, controller };
        entry.promise = this.#initialize(route, controller, entry); this.#entries.set(normalized, entry);
      }
      entry.references += 1; entry.lastUsed = now;
    });
    void this.#closeEntries(close);
    let bundle: Bundle;
    try { bundle = await entry.promise; } catch (error) { await this.#release(normalized, entry); throw error; }
    let released = false;
    return { bundle, release: async () => { if (released) return; released = true; await this.#release(normalized, entry); } };
  }

  /** Runs one complete provider operation under a lease and always releases capacity. */
  async withSessionForUser<Result>(userId: string, operation: (bundle: Bundle) => Promise<Result>): Promise<Result> {
    const lease = await this.leaseForUser(userId);
    try { return await operation(lease.bundle); } finally { await lease.release(); }
  }

  /** Initializes and verifies every configured tenant without retaining compatibility leases. */
  async checkReadiness(): Promise<void> {
    for (const userId of this.#resolver.routes.keys()) await this.withSessionForUser(userId, () => Promise.resolve(undefined));
  }

  /** Compatibility API. It pins one session per User until provider close; new code must use leases. */
  async sessionForUser(userId: string): Promise<Bundle> {
    const normalized = tenantId(userId); const existing = this.#compatibilityLeases.get(normalized); if (existing) return existing.bundle;
    const lease = await this.leaseForUser(normalized); const raced = this.#compatibilityLeases.get(normalized);
    if (raced) { await lease.release(); return raced.bundle; }
    this.#compatibilityLeases.set(normalized, lease); return lease.bundle;
  }

  async updateConfiguration(routes: TenantHypermailRouteMap, configVersion: string): Promise<void> {
    if (!configVersion) throw new Error("HYPERMAIL_TENANT_CONFIG_VERSION_REQUIRED"); const close: Entry<Bundle>[] = []; const compatibility: TenantHypermailSessionLease<Bundle>[] = [];
    const changed = await this.#locked(() => {
      if (this.#closed) throw new Error("HYPERMAIL_TENANT_SESSION_PROVIDER_CLOSED"); if (configVersion === this.#version) return false;
      compatibility.push(...this.#compatibilityLeases.values()); this.#compatibilityLeases.clear(); this.#resolver = new TenantHypermailRouteResolver(routes); this.#version = configVersion;
      for (const entry of this.#entries.values()) { entry.retiring = true; if (entry.references === 0) close.push(entry); }
      this.#entries.clear(); return true;
    });
    if (!changed) return; await Promise.all(compatibility.map(async lease => { await lease.release(); })); await this.#closeEntries(close);
  }

  async evictIdle(): Promise<void> { const close: Entry<Bundle>[] = []; await this.#locked(() => { const now = this.#now(); for (const [id, entry] of this.#entries) if (entry.references === 0 && now - entry.lastUsed >= this.#idle) { this.#entries.delete(id); entry.retiring = true; close.push(entry); } }); await this.#closeEntries(close); }
  async close(): Promise<void> {
    const close: Entry<Bundle>[] = []; const compatibility: TenantHypermailSessionLease<Bundle>[] = []; await this.#locked(() => { if (this.#closed) return; this.#closed = true; compatibility.push(...this.#compatibilityLeases.values()); this.#compatibilityLeases.clear(); for (const entry of this.#entries.values()) { entry.retiring = true; entry.controller.abort(); if (entry.references === 0) close.push(entry); } this.#entries.clear(); });
    await Promise.all(compatibility.map(async lease => { await lease.release(); })); await this.#closeEntries(close);
  }

  async #initialize(route: TenantHypermailRoute, controller: AbortController, entry: Entry<Bundle>): Promise<Bundle> {
    let timedOut = false;
    const raw = Promise.resolve().then(() => this.#factory(route, controller.signal));
    const aborted = new Promise<never>((_, reject) => { const fail = () => { reject(new Error("HYPERMAIL_TENANT_SESSION_INITIALIZATION_FAILED")); }; if (controller.signal.aborted) fail(); else controller.signal.addEventListener("abort", fail, { once: true }); });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#initializeTimeout); timer.unref();
    raw.then(bundle => { entry.bundle = bundle; if (timedOut || entry.retiring) void this.#closeEntryBundle(entry); }, () => undefined);
    try { const bundle = await Promise.race([raw, aborted]); clearTimeout(timer); return bundle; }
    catch { clearTimeout(timer); void this.#removeFailed(entry); throw new Error("HYPERMAIL_TENANT_SESSION_INITIALIZATION_FAILED"); }
  }
  async #removeFailed(entry: Entry<Bundle>): Promise<void> { await this.#locked(() => { for (const [id, candidate] of this.#entries) if (candidate === entry) this.#entries.delete(id); entry.retiring = true; }); }
  async #release(id: string, entry: Entry<Bundle>): Promise<void> { const close = await this.#locked(() => { if (entry.references > 0) entry.references -= 1; entry.lastUsed = this.#now(); const shouldClose = entry.references === 0 && entry.retiring; if (shouldClose && this.#entries.get(id) === entry) this.#entries.delete(id); return shouldClose; }); if (close) await this.#closeEntries([entry]); }
  async #closeBundle(bundle: Bundle): Promise<void> {
    if (!bundle.close) return; const controller = new AbortController(); const timer = setTimeout(() => { controller.abort(); }, this.#closeTimeout); timer.unref();
    try { const closing = bundle.close(controller.signal); await Promise.race([Promise.resolve(closing), new Promise<void>(resolve => { controller.signal.addEventListener("abort", () => { resolve(); }, { once: true }); })]); } catch { /* contained */ } finally { clearTimeout(timer); }
  }
  #closeEntryBundle(entry: Entry<Bundle>): Promise<void> { if (entry.bundleClose) return entry.bundleClose; if (!entry.bundle) return Promise.resolve(); entry.bundleClose = this.#closeBundle(entry.bundle); return entry.bundleClose; }
  #closeEntry(entry: Entry<Bundle>): Promise<void> { if (entry.closing) return entry.closing; entry.closing = (async () => { entry.controller.abort(); try { entry.bundle = await entry.promise; } catch { /* failed/timed-out initialization */ } await this.#closeEntryBundle(entry); })(); return entry.closing; }
  async #closeEntries(entries: readonly Entry<Bundle>[]): Promise<void> { await Promise.all(entries.map(async entry => { await this.#closeEntry(entry); })); }
  async #locked<T>(operation: () => T | Promise<T>): Promise<T> { const previous = this.#mutation; let release!: () => void; this.#mutation = new Promise<void>(resolve => { release = resolve; }); await previous; try { return await operation(); } finally { release(); } }
}

export interface DefaultTenantHypermailSessionProviderOptions extends Omit<TenantHypermailSessionProviderOptions, "createSession"> { protocolVersion?: string; fetch?: typeof fetch; maxRetries?: number; }
export function createTenantHypermailSessionProvider(options: DefaultTenantHypermailSessionProviderOptions): TenantHypermailSessionProvider {
  return new TenantHypermailSessionProvider({ ...options, createSession: async (route, signal) => {
    const protocolVersion = route.protocolVersion ?? options.protocolVersion; if (!protocolVersion) throw new Error("HYPERMAIL_TENANT_PROTOCOL_VERSION_REQUIRED");
    const read = new HypermailReadClient({ endpoint: route.endpoint, protocolVersion, headers: { authorization: `Bearer ${route.key}` }, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }) });
    try {
      if (signal?.aborted) throw new Error("HYPERMAIL_TENANT_SESSION_INITIALIZATION_FAILED");
      await read.initialize();
      if (signal?.aborted) throw new Error("HYPERMAIL_TENANT_SESSION_INITIALIZATION_FAILED");
      const policy = new HypermailPolicyClient(read.transport); await read.verifyPolicyContract(); return { read, policy, close: () => read.transport.close() };
    } catch (error) { await read.transport.close().catch(() => undefined); throw error; }
  } });
}

/** Compatibility cache for callers that already supply a trusted, per-User factory. */
export class TenantHypermailClientCache<Client> {
  readonly #clients = new Map<string, Client>();
  constructor(private readonly createClient: (userId: string) => Client) {}
  clientForUser(userId: string): Client {
    if (typeof userId !== "string" || !userId.trim()) throw new RangeError("Invalid user id.");
    const tenant = userId.trim(); let client = this.#clients.get(tenant);
    if (client === undefined) { client = this.createClient(tenant); this.#clients.set(tenant, client); }
    return client;
  }
}

/** Legacy compatibility. Prefer `create`, which proves the sole owner at startup. */
export class SingleOwnerTenantClient<Client> {
  #observedOwner: string | undefined;
  constructor(private readonly client: Client, private readonly owner?: string) {}
  static async create<Client>(client: Client, proveSoleUserIds: () => Promise<readonly string[]>): Promise<SingleOwnerTenantClient<Client>> {
    const owners = await proveSoleUserIds();
    if (owners.length !== 1 || typeof owners[0] !== "string" || owners[0].trim().length === 0) throw new Error("HYPERMAIL_LEGACY_SOLE_OWNER_REQUIRED");
    return new SingleOwnerTenantClient(client, owners[0].trim());
  }
  clientForUser(userId: string): Client {
    if (typeof userId !== "string" || !userId.trim()) throw new RangeError("Invalid user id.");
    const selected = userId.trim();
    if (this.owner !== undefined) {
      if (selected !== this.owner) throw new Error("HYPERMAIL_TENANT_CLIENT_REQUIRED");
    } else if (this.#observedOwner !== undefined && selected !== this.#observedOwner) {
      throw new Error("HYPERMAIL_TENANT_CLIENT_REQUIRED");
    } else { this.#observedOwner = selected; }
    return this.client;
  }
}
