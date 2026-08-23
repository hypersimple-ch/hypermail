/* eslint-disable @typescript-eslint/require-await */
import { randomUUID } from 'node:crypto';
import { Blob } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { MailboxMemory } from '@hypermail/agent';
import { HindsightMailboxMemory, HindsightMemoryError, mailboxBankId, ReadinessGatedMailboxMemory, type HindsightApi } from '../src/hindsight-memory.js';

const userId = randomUUID();
const mailboxId = randomUUID();
const scope = { userId, mailboxId };

const completeOpenApi = (): Record<string, unknown> => ({
  openapi: '3.1.0',
  paths: {
    '/v1/default/banks/{bank_id}': { put: { responses: {} }, delete: { responses: {} } },
    '/v1/default/banks/{bank_id}/memories': { post: { responses: {} } },
    '/v1/default/banks/{bank_id}/memories/recall': { post: { responses: {} } },
    '/v1/default/banks/{bank_id}/files/retain': { post: { responses: {} } },
    '/v1/default/banks/{bank_id}/operations/{operation_id}': { get: { responses: {} } },
  },
});

function fakeApi(overrides: Partial<HindsightApi> = {}): HindsightApi & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = <T>(method: string, result: T) => async (...args: unknown[]): Promise<T> => { calls.push({ method, args }); return result; };
  return {
    calls,
    getReadiness: record('getReadiness', { status: 'ready' }),
    getOpenApi: record('getOpenApi', completeOpenApi()),
    getVersion: record('getVersion', { api_version: '0.9.1', features: { observations: true, worker: true, bank_config_api: true, file_upload_api: true, store_document_text: true } }),
    createBank: record('createBank', { bank_id: mailboxBankId(scope), mission: 'x', name: 'x', disposition: { skepticism: 3, literalism: 3, empathy: 3 } }),
    retain: record('retain', { success: true, bank_id: mailboxBankId(scope), items_count: 1, async: true, operation_id: '11111111-1111-4111-8111-111111111111' }),
    recall: record('recall', { results: [], chunks: {} }),
    retainFiles: record('retainFiles', { operation_ids: ['22222222-2222-4222-8222-222222222222'] }),
    getOperationStatus: async (bankId, operationId) => { calls.push({ method: 'getOperationStatus', args: [bankId, operationId] }); return { operation_id: operationId, status: 'completed' }; },
    deleteBank: record('deleteBank', undefined),
    ...overrides,
  };
}

function memory(api: HindsightApi, timeoutMs = 100): HindsightMailboxMemory {
  return new HindsightMailboxMemory(api, { timeoutMs, pollIntervalMs: 1,
    now: (() => { let time = 0; return () => ++time; })(), wait: async () => undefined });
}

describe('Hindsight Mailbox memory adapter', () => {

  it('derives opaque stable bank IDs only from User and Mailbox UUIDs', () => {
    expect(mailboxBankId(scope)).toBe(mailboxBankId(scope));
    expect(mailboxBankId(scope)).not.toBe(mailboxBankId({ userId, mailboxId: randomUUID() }));
    expect(mailboxBankId(scope)).not.toBe(mailboxBankId({ userId: randomUUID(), mailboxId }));
    expect(mailboxBankId(scope)).not.toContain(userId);
    expect(mailboxBankId(scope)).not.toContain(mailboxId);
    expect(() => mailboxBankId({ userId: 'alice@example.test', mailboxId })).toThrow('MAILBOX_MEMORY_IDENTITY_INVALID');
  });

  it('lazily creates a bank and reuses deterministic document and operation IDs on retain retries', async () => {
    const api = fakeApi();
    api.retain = async (bankId, _content, options) => {
      api.calls.push({ method: 'retain', args: [bankId, options] });
      return { success: true, bank_id: bankId, items_count: 1, async: true, operation_id: options.operationId };
    };
    api.getOperationStatus = async (bankId, operationId) => {
      api.calls.push({ method: 'getOperationStatus', args: [bankId, operationId] });
      return { operation_id: operationId, status: 'completed' };
    };
    const adapter = memory(api);
    const retained = { scope, eventId: randomUUID(), text: '{"complete":"email"}', timestamp: '2026-01-01T00:00:00.000Z', context: 'email' };
    await adapter.retain(retained);
    await adapter.retain(retained);
    expect(api.calls.filter((call) => call.method === 'createBank')).toHaveLength(1);
    expect(api.calls.find((call) => call.method === 'createBank')?.args[1]).toMatchObject({ enableObservations: false });
    const retainOptions = api.calls.filter((call) => call.method === 'retain').map((call) => call.args[1] as { documentId: string; operationId: string });
    expect(retainOptions).toHaveLength(2);
    expect(retainOptions[0]).toMatchObject({ async: true, updateMode: 'replace' });
    expect(retainOptions[0]?.documentId).toBe(retainOptions[1]?.documentId);
    expect(retainOptions[0]?.operationId).toBe(retainOptions[1]?.operationId);
  });

  it('recalls bounded results with source chunks from the exact bank', async () => {
    const api = fakeApi();
    api.recall = async (...args) => {
      api.calls.push({ method: 'recall', args });
      return { results: [{ id: 'fact-1', text: 'Prefers invoice archiving', type: 'world', context: 'prior mail', chunk_id: 'chunk-1' }],
        chunks: { 'chunk-1': { id: 'chunk-1', text: 'Invoice source', chunk_index: 0 } } };
    };
    const result = await memory(api).recall({ scope, query: 'invoice', maxTokens: 1_024 });
    expect(result).toEqual({ entries: [{ text: 'Prefers invoice archiving', type: 'world', context: 'prior mail', sourceChunks: [{ id: 'chunk-1', text: 'Invoice source' }] }] });
    const recallCall = api.calls.find((call) => call.method === 'recall');
    expect(recallCall?.args[0]).toBe(mailboxBankId(scope));
    expect(recallCall?.args[2]).toMatchObject({ maxTokens: 1_024, includeChunks: true,
      types: ['world', 'experience'], preferObservations: false, includeSourceFacts: false });
  });

  it('uploads a direct supported file with a deterministic document ID and waits for completion', async () => {
    const api = fakeApi();
    const adapter = memory(api);
    await adapter.retainFile({ scope, sourceId: randomUUID(), file: new Blob(['hello'], { type: 'text/plain' }), filename: 'message.txt', mediaType: 'text/plain' });
    const upload = api.calls.find((call) => call.method === 'retainFiles');
    expect(upload?.args[0]).toBe(mailboxBankId(scope));
    const uploadOptions = upload?.args[2] as { filesMetadata?: Array<{ document_id?: string }> } | undefined;
    expect(uploadOptions?.filesMetadata?.[0]?.document_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(api.calls.some((call) => call.method === 'getOperationStatus')).toBe(true);
  });

  it('sanitizes timeouts, failures, and malformed responses', async () => {
    const never = new Promise<never>(() => undefined);
    await expect(memory(fakeApi({ recall: async () => never }), 2).recall({ scope, query: 'x', maxTokens: 1_024 }))
      .rejects.toMatchObject({ code: 'HINDSIGHT_TIMEOUT', message: 'Hindsight memory request timed out.' });
    await expect(memory(fakeApi({ recall: async () => ({ results: [{ text: 42 }] }) })).recall({ scope, query: 'x', maxTokens: 1_024 }))
      .rejects.toMatchObject({ code: 'HINDSIGHT_RESPONSE_INVALID' });
    await expect(memory(fakeApi({ recall: async () => { throw new Error('https://secret.internal:8888 token=secret'); } })).recall({ scope, query: 'x', maxTokens: 1_024 }))
      .rejects.toBeInstanceOf(HindsightMemoryError);
    await expect(memory(fakeApi({ recall: async () => { throw new Error('secret'); } })).recall({ scope, query: 'x', maxTokens: 1_024 }))
      .rejects.not.toThrow(/secret/);
  });

  it('blocks memory work after dynamic degradation until an exact readiness probe recovers', async () => {
    const calls: string[] = []; let healthy = true;
    const underlying: MailboxMemory = { retain: () => { calls.push('retain'); return Promise.resolve(); }, recall: () => Promise.resolve({ entries: [] }),
      retainFile: () => Promise.resolve(), deleteMailbox: () => Promise.resolve(),
      readiness: () => healthy ? Promise.resolve({ version: '0.9.1' }) : Promise.reject(new Error('down')) };
    const gate = new ReadinessGatedMailboxMemory(underlying);
    await expect(gate.retain({ scope, eventId: randomUUID(), text: 'x', timestamp: '2026-01-01T00:00:00.000Z', context: 'x' }))
      .rejects.toMatchObject({ code: 'HINDSIGHT_UNAVAILABLE' });
    await gate.readiness(); await gate.retain({ scope, eventId: randomUUID(), text: 'x', timestamp: '2026-01-01T00:00:00.000Z', context: 'x' });
    healthy = false; await expect(gate.readiness()).rejects.toThrow('down');
    await expect(gate.retain({ scope, eventId: randomUUID(), text: 'x', timestamp: '2026-01-01T00:00:00.000Z', context: 'x' }))
      .rejects.toMatchObject({ code: 'HINDSIGHT_UNAVAILABLE' });
    expect(calls).toEqual(['retain']);
  });

  it('accepts a complete read-only 0.9.1 contract before supporting explicit bank deletion', async () => {
    const api = fakeApi();
    const adapter = memory(api);
    await expect(adapter.readiness()).resolves.toEqual({ version: '0.9.1' });
    expect(api.calls.slice(0, 3).map(({ method }) => method)).toEqual(['getReadiness', 'getVersion', 'getOpenApi']);
    expect(api.calls.every(({ method }) => ['getReadiness', 'getVersion', 'getOpenApi'].includes(method))).toBe(true);
    await adapter.deleteMailbox(scope);
    expect(api.calls.find((call) => call.method === 'deleteBank')?.args[0]).toBe(mailboxBankId(scope));
  });

  it('fails closed before schema discovery for wrong versions or incomplete feature flags', async () => {
    const wrongVersion = fakeApi({ getVersion: async () => ({ api_version: '0.9.0', features: { observations: true } }) });
    await expect(memory(wrongVersion).readiness()).rejects.toMatchObject({ code: 'HINDSIGHT_RESPONSE_INVALID' });
    expect(wrongVersion.calls.some(({ method }) => method === 'getOpenApi')).toBe(false);
    const incompleteFeatures = fakeApi({ getVersion: async () => ({ api_version: '0.9.1', features: { observations: true, worker: true, bank_config_api: true, file_upload_api: false, store_document_text: true } }) });
    await expect(memory(incompleteFeatures).readiness()).rejects.toMatchObject({ code: 'HINDSIGHT_RESPONSE_INVALID' });
    expect(incompleteFeatures.calls.some(({ method }) => method === 'getOpenApi')).toBe(false);
  });

  it.each([
    ['bank create/configure', '/v1/default/banks/{bank_id}', 'put'],
    ['retain', '/v1/default/banks/{bank_id}/memories', 'post'],
    ['recall', '/v1/default/banks/{bank_id}/memories/recall', 'post'],
    ['file upload', '/v1/default/banks/{bank_id}/files/retain', 'post'],
    ['operation status', '/v1/default/banks/{bank_id}/operations/{operation_id}', 'get'],
    ['bank delete', '/v1/default/banks/{bank_id}', 'delete'],
  ])('rejects an incomplete OpenAPI schema missing %s', async (_operation, path, method) => {
    const document = completeOpenApi();
    const paths = document['paths'] as Record<string, Record<string, unknown>>;
    delete paths[path]?.[method];
    await expect(memory(fakeApi({ getOpenApi: async () => document })).readiness())
      .rejects.toMatchObject({ code: 'HINDSIGHT_RESPONSE_INVALID' });
  });

  it('rejects malformed and timed-out OpenAPI schemas without invoking adapter operations', async () => {
    const malformed = fakeApi({ getOpenApi: async () => ({ openapi: '3.1.0', paths: [] }) });
    await expect(memory(malformed).readiness()).rejects.toMatchObject({ code: 'HINDSIGHT_RESPONSE_INVALID' });
    expect(malformed.calls.every(({ method }) => !['createBank', 'retain', 'recall', 'retainFiles', 'getOperationStatus', 'deleteBank'].includes(method))).toBe(true);
    const never = new Promise<never>(() => undefined);
    await expect(memory(fakeApi({ getOpenApi: async () => never }), 2).readiness())
      .rejects.toMatchObject({ code: 'HINDSIGHT_TIMEOUT' });
  });
});
