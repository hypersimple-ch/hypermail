/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from "vitest";
import {
  SingleOwnerTenantClient, TenantHypermailRouteResolver, TenantHypermailSessionProvider,
  createTenantHypermailSessionProvider, parseTenantHypermailRoutes, type TenantHypermailClientBundle, type TenantHypermailRoute,
} from "../src/index.js";
import type { HypermailPolicyClient, HypermailReadClient } from "../src/index.js";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const json = (a = "https://one.internal/mcp", b = "https://two.internal/mcp") => JSON.stringify({
  [first]: { endpoint: a, key: "first-private-key", protocolVersion: "v1" },
  [second]: { endpoint: b, key: "second-private-key" },
});
type FakeBundle = TenantHypermailClientBundle & { endpoint: string; mailboxes: Map<string, string>; closed: number };
const fake = (route: TenantHypermailRoute): FakeBundle => {
  const bundle = { endpoint: route.endpoint, mailboxes: new Map<string, string>(), closed: 0,
    read: {} as HypermailReadClient, policy: {} as HypermailPolicyClient,
    close() { bundle.closed++; },
  }; return bundle;
};

describe("tenant Hypermail route configuration", () => {
  it("strictly parses UUID routes and resolves without a global fallback", () => {
    const routes = parseTenantHypermailRoutes(json());
    expect(new TenantHypermailRouteResolver(routes).routeForUser(first)).toMatchObject({ endpoint: "https://one.internal/mcp", key: "first-private-key" });
    expect(() => new TenantHypermailRouteResolver(routes).routeForUser("33333333-3333-4333-8333-333333333333")).toThrow("HYPERMAIL_TENANT_ROUTE_MISSING");
  });
  it("keeps tenant-private approved-send endpoints isolated with the mailbox route", () => {
    const routes = parseTenantHypermailRoutes(JSON.stringify({
      [first]: { endpoint: "https://one.internal/mcp", key: "first-private-key", approvedSendEndpoint: "https://one.internal/approved", approvedSendToken: "first-approved-secret" },
      [second]: { endpoint: "https://two.internal/mcp", key: "second-private-key", approvedSendEndpoint: "https://two.internal/approved", approvedSendToken: "second-approved-secret" },
    }));
    expect(new TenantHypermailRouteResolver(routes).routeForUser(first).approvedSendEndpoint).toBe("https://one.internal/approved");
    expect(new TenantHypermailRouteResolver(routes).routeForUser(second).approvedSendEndpoint).toBe("https://two.internal/approved");
  });
  it("rejects malformed JSON, exact-field violations, endpoint credentials and endpoint reuse", () => {
    expect(() => parseTenantHypermailRoutes("{nope")).toThrow("HYPERMAIL_TENANT_ROUTES_INVALID");
    expect(() => parseTenantHypermailRoutes(JSON.stringify({ [first]: { endpoint: "ftp://one", key: "x" } }))).toThrow("HYPERMAIL_TENANT_ROUTES_INVALID");
    expect(() => parseTenantHypermailRoutes(JSON.stringify({ [first]: { endpoint: "https://user:pass@one/mcp", key: "x" } }))).toThrow("HYPERMAIL_TENANT_ROUTES_INVALID");
    expect(() => parseTenantHypermailRoutes(JSON.stringify({ [first]: { endpoint: "https://one/mcp", key: "", extra: true } }))).toThrow("HYPERMAIL_TENANT_ROUTES_INVALID");
    expect(() => parseTenantHypermailRoutes(json("https://shared/mcp", "https://shared/mcp"))).toThrow("HYPERMAIL_TENANT_ENDPOINT_REUSED");
  });
});

describe("TenantHypermailSessionProvider", () => {
  it("isolates two Users using the same mailbox at distinct endpoints and coalesces initialization", async () => {
    const calls: string[] = []; const provider = new TenantHypermailSessionProvider<FakeBundle>({ routes: parseTenantHypermailRoutes(json()), configVersion: "one", createSession: async (route) => { calls.push(route.endpoint); return fake(route); } });
    const [a, duplicate, b] = await Promise.all([provider.leaseForUser(first), provider.leaseForUser(first), provider.leaseForUser(second)]);
    a.bundle.mailboxes.set("same@example.test", "first"); b.bundle.mailboxes.set("same@example.test", "second");
    expect(duplicate.bundle).toBe(a.bundle); expect(b.bundle).not.toBe(a.bundle); expect(calls).toHaveLength(2);
    expect(a.bundle.mailboxes.get("same@example.test")).toBe("first"); expect(b.bundle.mailboxes.get("same@example.test")).toBe("second");
    await Promise.all([a.release(), duplicate.release(), b.release()]); await provider.close();
  });
  it("rotates configuration, evicts LRU/idle sessions, and closes exactly once", async () => {
    let now = 0; const made: FakeBundle[] = [];
    const provider = new TenantHypermailSessionProvider<FakeBundle>({ routes: parseTenantHypermailRoutes(json()), configVersion: "one", maxSessions: 1, idleTimeoutMs: 10, now: () => now, createSession: async (route) => { const value = fake(route); made.push(value); return value; } });
    const firstLease=await provider.leaseForUser(first);await firstLease.release();now = 1;const secondLease=await provider.leaseForUser(second);await secondLease.release();await new Promise(resolve=>setTimeout(resolve,0));expect(made[0]?.closed).toBe(1);
    now = 20; await provider.evictIdle(); expect(made[1]?.closed).toBe(1);
    await provider.updateConfiguration(parseTenantHypermailRoutes(json("https://new-one/mcp", "https://new-two/mcp")), "two");
    const updated=await provider.leaseForUser(first);expect(updated.bundle.endpoint).toBe("https://new-one/mcp");await updated.release();
    await provider.close(); expect(made[2]?.closed).toBe(1); await provider.close(); expect(made[2]?.closed).toBe(1);
    await expect(provider.leaseForUser(first)).rejects.toThrow("HYPERMAIL_TENANT_SESSION_PROVIDER_CLOSED");
  });
  it("releases operation-scoped sessions on success and failure", async () => {
    const made: FakeBundle[]=[];const provider=new TenantHypermailSessionProvider<FakeBundle>({routes:parseTenantHypermailRoutes(json()),configVersion:"one",maxSessions:1,createSession:async route=>{const value=fake(route);made.push(value);return value;}});
    await expect(provider.withSessionForUser(first,async bundle=>bundle.endpoint)).resolves.toBe("https://one.internal/mcp");
    await expect(provider.withSessionForUser(second,async()=>{throw new Error("operation failed");})).rejects.toThrow("operation failed");
    await expect(provider.withSessionForUser(first,async bundle=>bundle.endpoint)).resolves.toBe("https://one.internal/mcp");
    expect(made[0]?.closed).toBe(1);expect(made[1]?.closed).toBe(1);await provider.close();
  });
  it("checks every configured tenant without pinning readiness sessions", async () => {
    const initialized:string[]=[];const provider=new TenantHypermailSessionProvider<FakeBundle>({routes:parseTenantHypermailRoutes(json()),configVersion:"one",maxSessions:1,createSession:async route=>{initialized.push(route.endpoint);return fake(route);}});
    await provider.checkReadiness();expect(initialized).toEqual(["https://one.internal/mcp","https://two.internal/mcp"]);
    await expect(provider.withSessionForUser(first,async bundle=>bundle.endpoint)).resolves.toBe("https://one.internal/mcp");await provider.close();
  });
  it("never evicts a held lease and admits it after release", async () => {
    const made: FakeBundle[]=[];const provider=new TenantHypermailSessionProvider<FakeBundle>({routes:parseTenantHypermailRoutes(json()),configVersion:"one",maxSessions:1,createSession:async route=>{const value=fake(route);made.push(value);return value;}});
    const held=await provider.leaseForUser(first);await expect(provider.leaseForUser(second)).rejects.toThrow("HYPERMAIL_TENANT_SESSION_CAPACITY_EXHAUSTED");expect(held.bundle.closed).toBe(0);
    await held.release();const admitted=await provider.leaseForUser(second);expect(held.bundle.closed).toBe(1);await admitted.release();await provider.close();
  });
  it("does not close a held lease during provider shutdown", async () => {
    const provider=new TenantHypermailSessionProvider<FakeBundle>({routes:parseTenantHypermailRoutes(json()),configVersion:"one",createSession:async route=>fake(route)});const held=await provider.leaseForUser(first);await provider.close();expect(held.bundle.closed).toBe(0);await held.release();expect(held.bundle.closed).toBe(1);
  });
  it("bounds hung initialization and close without holding tenant metadata", async () => {
    const provider=new TenantHypermailSessionProvider<FakeBundle>({routes:parseTenantHypermailRoutes(json()),configVersion:"one",maxSessions:2,initializeTimeoutMs:20,closeTimeoutMs:20,createSession:async route=>route.endpoint.includes("one.internal")?await new Promise<FakeBundle>(()=>{}):{...fake(route),close:()=>new Promise<void>(()=>{})}});
    const hung=provider.leaseForUser(first);const healthy=await provider.leaseForUser(second);expect(healthy.bundle.endpoint).toContain("two.internal");await healthy.release();await expect(hung).rejects.toThrow("HYPERMAIL_TENANT_SESSION_INITIALIZATION_FAILED");
    const started=Date.now();await provider.close();expect(Date.now()-started).toBeLessThan(200);
  });
  it("closes a bundle that arrives after initialization timeout", async () => {
    let resolve!: (bundle:FakeBundle)=>void;const late=fake({endpoint:"https://one.internal/mcp",key:"key"});const provider=new TenantHypermailSessionProvider<FakeBundle>({routes:parseTenantHypermailRoutes(json()),configVersion:"one",initializeTimeoutMs:10,closeTimeoutMs:10,createSession:()=>new Promise<FakeBundle>(done=>{resolve=done})});
    await expect(provider.leaseForUser(first)).rejects.toThrow("HYPERMAIL_TENANT_SESSION_INITIALIZATION_FAILED");resolve(late);await new Promise(done=>setTimeout(done,0));expect(late.closed).toBe(1);await provider.close();expect(late.closed).toBe(1);
  });
  it("closes transport when policy contract verification fails after initialization", async () => {
    let deletes=0;const request:typeof fetch=async(_url,init)=>{if(init?.method==='DELETE'){deletes++;return new Response(null,{status:200});}const raw=init?.body;if(typeof raw!=="string")throw new Error("body");const body=JSON.parse(raw) as {id?:number;method:string};if(body.method==='notifications/initialized')return new Response(null,{status:202,headers:{'mcp-session-id':'session-1'}});const result=body.method==='initialize'?{protocolVersion:'v1',capabilities:{}}:{tools:[]};return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result}),{headers:{'content-type':'application/json','mcp-session-id':'session-1'}});};
    const provider=createTenantHypermailSessionProvider({routes:parseTenantHypermailRoutes(json()),configVersion:'one',protocolVersion:'v1',fetch:request});
    await expect(provider.leaseForUser(first)).rejects.toThrow('HYPERMAIL_TENANT_SESSION_INITIALIZATION_FAILED');expect(deletes).toBe(1);await provider.close();
  });
  it("does not poison the cache after failed initialization", async () => {
    let attempts = 0; const provider = new TenantHypermailSessionProvider<FakeBundle>({ routes: parseTenantHypermailRoutes(json()), configVersion: "one", createSession: async (route) => { attempts++; if (attempts === 1) throw new Error("secret remote failure"); return fake(route); } });
    const error = await provider.leaseForUser(first).catch((caught: unknown) => caught);
    expect(String(error)).toContain("HYPERMAIL_TENANT_SESSION_INITIALIZATION_FAILED"); expect(String(error)).not.toContain("secret remote failure");
    const retry=await provider.leaseForUser(first);expect(retry.bundle).toMatchObject({ endpoint: "https://one.internal/mcp" });await retry.release();expect(attempts).toBe(2);await provider.close();
  });
});

describe("legacy sole-owner compatibility", () => {
  it("requires async sole-owner proof and rejects a second User", async () => {
    const client = {}; const adapter = await SingleOwnerTenantClient.create(client, async () => [first]);
    expect(adapter.clientForUser(first)).toBe(client); expect(() => adapter.clientForUser(second)).toThrow("HYPERMAIL_TENANT_CLIENT_REQUIRED");
    await expect(SingleOwnerTenantClient.create(client, async () => [])).rejects.toThrow("HYPERMAIL_LEGACY_SOLE_OWNER_REQUIRED");
    await expect(SingleOwnerTenantClient.create(client, async () => [first, second])).rejects.toThrow("HYPERMAIL_LEGACY_SOLE_OWNER_REQUIRED");
  });
});
