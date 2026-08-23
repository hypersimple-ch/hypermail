import { describe, expect, it } from 'vitest';
import { backupEnvSchema, parseEnvironment, redactEnvironment, webEnvSchema, workerEnvSchema } from '../src/env.js';
import { approvedSendCapability } from '../src/runtime.js';

const validWorker = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:password@postgres:5432/hypermail',
  HYPERMAIL_URL: 'http://hypermail:3000/mcp',
  HYPERMAIL_KEY: 'not-a-real-secret-value',
  HYPERMAIL_PROTOCOL_VERSION: 'deployment-negotiated',
  HINDSIGHT_URL: 'http://hindsight:8888',
  HINDSIGHT_EXPECTED_VERSION: '0.9.1',
  MODEL_PROVIDER: 'openai',
  MODEL_NAME: 'configured-at-deploy',
  MODEL_API_KEY: 'not-a-real-model-secret',
  VAPID_SUBJECT: 'mailto:owner@example.test',
  VAPID_PUBLIC_KEY: 'public-key-value-123',
  VAPID_PRIVATE_KEY: 'private-key-value-123',
  PUSH_SUBSCRIPTION_ENCRYPTION_KEY: 'push-encryption-key-value-123456789',
  AGENT_GLOBAL_CONSTRAINTS: 'Follow the configured owner policy.',
  ATTACHMENT_TEMP_DIRECTORY: '/var/lib/hypermail-attachments',
  POLL_INTERVAL_SECONDS: '45',
  BODY_RETENTION_DAYS: '90',
  INCORRECT_MUTATION_THRESHOLD: '0.01',
};

describe('environment contracts', () => {
  it('accepts tenant routing as an env-only opaque JSON contract and redacts it', () => {
    const configured = parseEnvironment(workerEnvSchema, { ...validWorker, HYPERMAIL_TENANT_ROUTES: '{"tenant":"configuration"}' });
    expect(configured.HYPERMAIL_TENANT_ROUTES).toBe('{"tenant":"configuration"}');
    expect(redactEnvironment(configured).HYPERMAIL_TENANT_ROUTES).toBe('[REDACTED]');
  });
  it('requires a private attachment directory and HTTPS approved-send endpoint', () => {
    const base = {
      NODE_ENV: 'test', DATABASE_URL: validWorker.DATABASE_URL, APP_ORIGIN: 'https://mail.example.test', AUTH_SECRET: 'a'.repeat(32), OAUTH_TOKEN_HASH_KEY: 'o'.repeat(32),
      RECOVERY_RECIPIENT: 'owner@example.test', HYPERMAIL_URL: validWorker.HYPERMAIL_URL, HYPERMAIL_KEY: validWorker.HYPERMAIL_KEY,
      HYPERMAIL_PROTOCOL_VERSION: validWorker.HYPERMAIL_PROTOCOL_VERSION, VAPID_SUBJECT: 'mailto:owner@example.test', VAPID_PUBLIC_KEY: 'public-key-value-123', VAPID_PRIVATE_KEY: 'private-key-value-123',
      PUSH_SUBSCRIPTION_ENCRYPTION_KEY: validWorker.PUSH_SUBSCRIPTION_ENCRYPTION_KEY, ATTACHMENT_TEMP_DIRECTORY: '/var/lib/hypermail-attachments', APPROVED_SEND_URL: 'https://approved-send.private.test', APPROVED_SEND_TOKEN: 'approved-send-token-value',
    };
    expect(parseEnvironment(webEnvSchema, base).ATTACHMENT_MAX_BYTES).toBe(25 * 1024 * 1024);
    expect(approvedSendCapability(parseEnvironment(webEnvSchema, base))).toBe('configured');
    const withoutSend = Object.fromEntries(Object.entries(base).filter(([name]) => !name.startsWith('APPROVED_SEND_')));
    expect(approvedSendCapability(parseEnvironment(webEnvSchema, withoutSend))).toBe('disabled');
    expect(() => parseEnvironment(webEnvSchema, { ...withoutSend, APPROVED_SEND_TOKEN: base.APPROVED_SEND_TOKEN })).toThrow(/APPROVED_SEND_URL/);
    expect(() => parseEnvironment(webEnvSchema, { ...base, ATTACHMENT_TEMP_DIRECTORY: '/tmp/hypermail' })).toThrow(/ATTACHMENT_TEMP_DIRECTORY/);
    expect(() => parseEnvironment(webEnvSchema, { ...base, APPROVED_SEND_URL: 'http://approved-send:3000' })).toThrow(/APPROVED_SEND_URL/);
  });

  it('allows HTTPS APP_ORIGIN everywhere and HTTP only for development loopback URLs', () => {
    const base = {
      NODE_ENV: 'test', DATABASE_URL: validWorker.DATABASE_URL, APP_ORIGIN: 'https://mail.example.test', AUTH_SECRET: 'a'.repeat(32), OAUTH_TOKEN_HASH_KEY: 'o'.repeat(32),
      RECOVERY_RECIPIENT: 'owner@example.test', HYPERMAIL_URL: validWorker.HYPERMAIL_URL, HYPERMAIL_KEY: validWorker.HYPERMAIL_KEY,
      HYPERMAIL_PROTOCOL_VERSION: validWorker.HYPERMAIL_PROTOCOL_VERSION, VAPID_SUBJECT: validWorker.VAPID_SUBJECT, VAPID_PUBLIC_KEY: validWorker.VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: validWorker.VAPID_PRIVATE_KEY, PUSH_SUBSCRIPTION_ENCRYPTION_KEY: validWorker.PUSH_SUBSCRIPTION_ENCRYPTION_KEY,
      ATTACHMENT_TEMP_DIRECTORY: '/var/lib/hypermail-attachments',
    };
    expect(parseEnvironment(webEnvSchema, { ...base, NODE_ENV: 'production' }).APP_ORIGIN).toBe('https://mail.example.test');
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      expect(parseEnvironment(webEnvSchema, { ...base, NODE_ENV: 'development', APP_ORIGIN: origin }).APP_ORIGIN).toBe(origin);
    }
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      expect(() => parseEnvironment(webEnvSchema, { ...base, NODE_ENV: 'test', APP_ORIGIN: origin })).toThrow(/APP_ORIGIN/);
      expect(() => parseEnvironment(webEnvSchema, { ...base, NODE_ENV: 'production', APP_ORIGIN: origin })).toThrow(/APP_ORIGIN/);
    }
    expect(() => parseEnvironment(webEnvSchema, { ...base, NODE_ENV: 'development', APP_ORIGIN: 'http://mail.example.test' })).toThrow(/APP_ORIGIN/);
    expect(() => parseEnvironment(webEnvSchema, { ...base, NODE_ENV: 'development', APP_ORIGIN: 'http://::1:3000' })).toThrow(/APP_ORIGIN/);
  });

  it('uses Codex CLI defaults only in development and requires hosted-provider secrets', () => {
    const withoutModel = Object.fromEntries(Object.entries(validWorker).filter(([name]) => !name.startsWith('MODEL_')));
    const development = parseEnvironment(workerEnvSchema, { ...withoutModel, NODE_ENV: 'development' });
    expect(development.MODEL_PROVIDER).toBe('codex-cli');
    expect(development.MODEL_NAME).toBe('default');
    expect(development.MODEL_API_KEY).toBeUndefined();
    expect(parseEnvironment(workerEnvSchema, { ...withoutModel, NODE_ENV: 'development', MODEL_PROVIDER: 'codex-cli', MODEL_API_KEY: validWorker.MODEL_API_KEY }).MODEL_API_KEY).toBe(validWorker.MODEL_API_KEY);
    expect(parseEnvironment(workerEnvSchema, { ...withoutModel, NODE_ENV: 'production', MODEL_PROVIDER: 'codex-cli', MODEL_NAME: 'default' }).MODEL_API_KEY).toBeUndefined();
    for (const provider of ['openai', 'anthropic', 'google']) {
      expect(() => parseEnvironment(workerEnvSchema, { ...withoutModel, NODE_ENV: 'development', MODEL_PROVIDER: provider })).toThrow(/MODEL_API_KEY/);
      expect(parseEnvironment(workerEnvSchema, { ...withoutModel, NODE_ENV: 'production', MODEL_PROVIDER: provider, MODEL_NAME: 'configured-at-deploy', MODEL_API_KEY: validWorker.MODEL_API_KEY }).MODEL_PROVIDER).toBe(provider);
    }
    expect(() => parseEnvironment(workerEnvSchema, { ...withoutModel, NODE_ENV: 'production' })).toThrow(/MODEL_PROVIDER|MODEL_NAME/);
  });

  it('requires the pinned private Hindsight contract and bounds its client limits', () => {
    const env = parseEnvironment(workerEnvSchema, {
      ...validWorker,
      HINDSIGHT_API_KEY: 'private-hindsight-key-value',
      HINDSIGHT_REQUEST_TIMEOUT_MS: '45000',
      HINDSIGHT_MAX_FILE_BYTES: '1048576',
    });
    expect(env).toMatchObject({
      HINDSIGHT_URL: 'http://hindsight:8888',
      HINDSIGHT_EXPECTED_VERSION: '0.9.1',
      HINDSIGHT_REQUEST_TIMEOUT_MS: 45_000,
      HINDSIGHT_MAX_FILE_BYTES: 1_048_576,
    });
    expect(redactEnvironment(env).HINDSIGHT_API_KEY).toBe('[REDACTED]');
    expect(() => parseEnvironment(workerEnvSchema, { ...validWorker, HINDSIGHT_EXPECTED_VERSION: 'latest' })).toThrow(/HINDSIGHT_EXPECTED_VERSION/);
    expect(() => parseEnvironment(workerEnvSchema, { ...validWorker, HINDSIGHT_URL: 'http://hindsight:8888/path' })).toThrow(/HINDSIGHT_URL/);
    expect(() => parseEnvironment(workerEnvSchema, { ...validWorker, HINDSIGHT_MAX_FILE_BYTES: String(25 * 1024 * 1024 + 1) })).toThrow(/HINDSIGHT_MAX_FILE_BYTES/);
  });

  it('coerces bounded operational settings', () => {
    const env = parseEnvironment(workerEnvSchema, validWorker);
    expect(env.POLL_INTERVAL_SECONDS).toBe(45);
    expect(env.INCORRECT_MUTATION_THRESHOLD).toBe(0.01);
    expect(env.HINDSIGHT_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(env.HINDSIGHT_MAX_FILE_BYTES).toBe(10 * 1024 * 1024);
  });

  it('rejects unknown variables and unsafe polling intervals without echoing values', () => {
    expect(() => parseEnvironment(workerEnvSchema, {
      ...validWorker,
      POLL_INTERVAL_SECONDS: '5',
      ACCIDENTAL_SECRET: 'must-not-appear',
    })).toThrow(/POLL_INTERVAL_SECONDS|ACCIDENTAL_SECRET/);
    try {
      parseEnvironment(workerEnvSchema, { ...validWorker, MODEL_API_KEY: 'short' });
    } catch (error) {
      expect(String(error)).not.toContain('short');
    }
  });

  it('requires separate secret-file paths for both backup encryption domains', () => {
    const backup = parseEnvironment(backupEnvSchema, {
      DATABASE_URL: validWorker.DATABASE_URL,
      BACKUP_TARGET: 's3://backup-bucket/hypermail',
      BACKUP_ENCRYPTION_KEY_FILE: '/run/secrets/backup-database-key',
      BACKUP_STATE_ENCRYPTION_KEY_FILE: '/run/secrets/backup-state-key',
      BACKUP_RETENTION_DAYS: '30',
    });
    expect(backup.BACKUP_RETENTION_DAYS).toBe(30);
    expect(() => parseEnvironment(backupEnvSchema, { ...backup, BACKUP_STATE_ENCRYPTION_KEY_FILE: '/tmp/key' })).toThrow(/BACKUP_STATE_ENCRYPTION_KEY_FILE/);
    expect(() => parseEnvironment(backupEnvSchema, { ...backup, BACKUP_TARGET: '/local/backups' })).toThrow(/BACKUP_TARGET/);
  });

  it('redacts secret-looking fields', () => {
    expect(redactEnvironment(validWorker)).toMatchObject({
      DATABASE_URL: '[REDACTED]',
      HYPERMAIL_KEY: '[REDACTED]',
      MODEL_API_KEY: '[REDACTED]',
      POLL_INTERVAL_SECONDS: '45',
    });
  });
});
