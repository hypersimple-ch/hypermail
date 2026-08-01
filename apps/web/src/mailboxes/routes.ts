import type { AddAccountInput, CompleteAddAccountInput, ImapAddAccountConfig, Provider } from '@hypermail/hypermail';
import { MailboxInputError, MailboxUnavailableError, type MailboxScope } from './contracts.js';
import type { MailboxService } from './service.js';

export type MailboxRouteRequest = Readonly<{
  method: string;
  origin: string | null;
  auth: MailboxScope | null;
  body: Readonly<Record<string, unknown>>;
}>;
export type MailboxRouteResponse = Readonly<{ status: number; body: Readonly<Record<string, unknown>> }>;
export type MailboxRouteOptions = Readonly<{ expectedOrigin: string }>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOnly = (value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));
const nonEmpty = (value: unknown, maximum = 320): string => {
  if (typeof value !== 'string') throw new MailboxInputError();
  const result = value.trim();
  if (!result || result.length > maximum) throw new MailboxInputError();
  return result;
};
const optionalText = (value: unknown, maximum = 320): string | undefined => value === undefined ? undefined : nonEmpty(value, maximum);
const email = (value: unknown, required: boolean): string | undefined => {
  const result = optionalText(value, 320);
  if (required && !result) throw new MailboxInputError();
  if (result && !/^[^\s@]+@[^\s@]+$/.test(result)) throw new MailboxInputError();
  return result?.toLowerCase();
};
const port = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) throw new MailboxInputError();
  return value;
};
const optionalBoolean = (value: unknown): boolean | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new MailboxInputError();
  return value;
};
const provider = (value: unknown): Provider => {
  if (value !== 'gmail' && value !== 'outlook' && value !== 'imap') throw new MailboxInputError();
  return value;
};

function startInput(body: Readonly<Record<string, unknown>>): AddAccountInput {
  if (!hasOnly(body, ['provider', 'email', 'config'])) throw new MailboxInputError();
  const selected = provider(body['provider']);
  if (selected !== 'imap') {
    if (body['config'] !== undefined) throw new MailboxInputError();
    const mailboxEmail = email(body['email'], false);
    return { provider: selected, ...(mailboxEmail ? { email: mailboxEmail } : {}) };
  }

  const mailboxEmail = email(body['email'], true);
  const raw = body['config'];
  if (!isRecord(raw) || !hasOnly(raw, ['host', 'port', 'secure', 'user', 'password', 'smtpHost', 'smtpPort', 'smtpSecure'])) throw new MailboxInputError();
  const host = nonEmpty(raw['host'], 255);
  const user = nonEmpty(raw['user'], 320);
  const password = nonEmpty(raw['password'], 1_024);
  if (/\s/.test(host)) throw new MailboxInputError();
  const imapPort = port(raw['port']);
  const secure = optionalBoolean(raw['secure']);
  const smtpHost = optionalText(raw['smtpHost'], 255);
  const smtpPort = port(raw['smtpPort']);
  const smtpSecure = optionalBoolean(raw['smtpSecure']);
  if (!smtpHost && (smtpPort !== undefined || smtpSecure !== undefined)) throw new MailboxInputError();
  if (smtpHost && /\s/.test(smtpHost)) throw new MailboxInputError();
  const config: ImapAddAccountConfig = {
    host,
    user,
    password,
    ...(imapPort !== undefined ? { port: imapPort } : {}),
    ...(secure !== undefined ? { secure } : {}),
    ...(smtpHost ? { smtpHost } : {}),
    ...(smtpPort !== undefined ? { smtpPort } : {}),
    ...(smtpSecure !== undefined ? { smtpSecure } : {}),
  };
  return { provider: selected, email: mailboxEmail as string, config };
}

function completeInput(body: Readonly<Record<string, unknown>>): CompleteAddAccountInput {
  if (!hasOnly(body, ['provider', 'handle', 'authorizationResponse', 'code', 'state'])) throw new MailboxInputError();
  const selected = provider(body['provider']);
  if (selected === 'imap') throw new MailboxInputError();
  const authorizationResponse = optionalText(body['authorizationResponse'], 8_192);
  const code = optionalText(body['code'], 4_096);
  const state = optionalText(body['state'], 4_096);
  return {
    provider: selected,
    handle: nonEmpty(body['handle'], 2_048),
    ...(authorizationResponse ? { authorizationResponse } : {}),
    ...(code ? { code } : {}),
    ...(state ? { state } : {}),
  };
}

const errorResponse = (error: unknown): MailboxRouteResponse => {
  if (error instanceof MailboxInputError) return { status: 400, body: { error: { code: 'BAD_REQUEST', message: error.message } } };
  if (error instanceof MailboxUnavailableError) return { status: 503, body: { error: { code: 'PROVIDER_UNAVAILABLE', message: error.message } } };
  return { status: 503, body: { error: { code: 'PROVIDER_UNAVAILABLE', message: 'Mailbox provider is unavailable.' } } };
};

/** Same-origin, authenticated routes for explicit owner actions only. */
export function createMailboxRoutes(service: MailboxService, options: MailboxRouteOptions) {
  const gate = (request: MailboxRouteRequest): MailboxRouteResponse | null => {
    if (request.method !== 'POST') return { status: 405, body: { error: { code: 'METHOD_NOT_ALLOWED' } } };
    if (request.origin !== options.expectedOrigin) return { status: 403, body: { error: { code: 'CROSS_ORIGIN' } } };
    if (!request.auth) return { status: 401, body: { error: { code: 'UNAUTHENTICATED' } } };
    return null;
  };
  return {
    async start(request: MailboxRouteRequest): Promise<MailboxRouteResponse> {
      const denied = gate(request); if (denied) return denied;
      try {
        const result = await service.start(request.auth as MailboxScope, startInput(request.body));
        return { status: result.status === 'pending' ? 202 : 201, body: result };
      } catch (error) { return errorResponse(error); }
    },
    async complete(request: MailboxRouteRequest): Promise<MailboxRouteResponse> {
      const denied = gate(request); if (denied) return denied;
      try {
        const result = await service.complete(request.auth as MailboxScope, completeInput(request.body));
        const status = result.status === 'ready' ? 200 : result.status === 'pending' ? 202 : result.status === 'expired' ? 410 : 502;
        return { status, body: result };
      } catch (error) { return errorResponse(error); }
    },
  };
}
