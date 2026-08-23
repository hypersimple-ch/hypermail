import { z } from 'zod';

const nodeEnv = z.enum(['development', 'test', 'production']).default('development');
const databaseUrl = z.url().startsWith('postgresql://');
const httpsOrigin = z.url().refine(
  (value) => new URL(value).protocol === 'https:',
  'must use https',
);
const appOrigin = z.url().refine((value) => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash && value === url.origin; } catch { return false; }
}, 'must be an exact root http(s) origin without credentials, path, query, fragment, or trailing slash');
const privateServiceOrigin = appOrigin;
const loopbackHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);

function isHttpsOrigin(origin: string): boolean {
  try { return new URL(origin).protocol === 'https:'; } catch { return false; }
}
function isDevelopmentLoopbackOrigin(origin: string, nodeEnvironment: string): boolean {
  try {
    const url = new URL(origin);
    return nodeEnvironment === 'development' && url.protocol === 'http:' && loopbackHostnames.has(url.hostname);
  } catch { return false; }
}
const secret = z.string().min(16);
const positiveInteger = z.coerce.number().int().positive();

const shared = {
  NODE_ENV: nodeEnv,
  DATABASE_URL: databaseUrl,
};

export const webEnvSchema = z.strictObject({
  ...shared,
  APP_ORIGIN: appOrigin,
  AUTH_SECRET: z.string().min(32),
  OAUTH_TOKEN_HASH_KEY: z.string().min(32),
  RECOVERY_RECIPIENT: z.email(),
  HYPERMAIL_URL: z.url(),
  HYPERMAIL_KEY: secret,
  HYPERMAIL_PROTOCOL_VERSION: z.string().min(1),
  HYPERMAIL_TENANT_ROUTES: z.string().min(2).optional(),
  VAPID_SUBJECT: z.string().startsWith('mailto:'),
  VAPID_PUBLIC_KEY: secret,
  VAPID_PRIVATE_KEY: secret,
  PUSH_SUBSCRIPTION_ENCRYPTION_KEY: z.string().min(32),
  ATTACHMENT_TEMP_DIRECTORY: z.string().startsWith('/').refine((value) => value !== '/tmp' && !value.startsWith('/tmp/'), 'must not use shared /tmp'),
  ATTACHMENT_MAX_BYTES: positiveInteger.default(25 * 1024 * 1024),
  ATTACHMENT_ORPHAN_MAX_AGE_SECONDS: positiveInteger.default(60 * 60),
  APPROVED_SEND_URL: httpsOrigin.optional(),
  APPROVED_SEND_TOKEN: secret.optional(),
}).superRefine((environment, context) => {
  if (!isHttpsOrigin(environment.APP_ORIGIN) && !isDevelopmentLoopbackOrigin(environment.APP_ORIGIN, environment.NODE_ENV)) {
    context.addIssue({ code: 'custom', path: ['APP_ORIGIN'], message: 'must use https except for development loopback origins' });
  }
  if ((environment.APPROVED_SEND_URL === undefined) !== (environment.APPROVED_SEND_TOKEN === undefined)) {
    context.addIssue({ code: 'custom', path: ['APPROVED_SEND_URL'], message: 'approved send URL and token must be configured together' });
  }
});

export const workerEnvSchema = z.strictObject({
  ...shared,
  HYPERMAIL_URL: z.url(),
  HYPERMAIL_KEY: secret,
  HYPERMAIL_PROTOCOL_VERSION: z.string().min(1),
  HYPERMAIL_TENANT_ROUTES: z.string().min(2).optional(),
  HINDSIGHT_URL: privateServiceOrigin,
  HINDSIGHT_API_KEY: secret.optional(),
  HINDSIGHT_EXPECTED_VERSION: z.literal('0.9.1'),
  HINDSIGHT_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  HINDSIGHT_MAX_FILE_BYTES: z.coerce.number().int().min(1).max(25 * 1024 * 1024).default(10 * 1024 * 1024),
  MAILBOX_MEMORY_RETRY_BASE_DELAY_SECONDS: z.coerce.number().int().min(1).max(3_600).default(5),
  MAILBOX_MEMORY_RETRY_MAXIMUM_DELAY_SECONDS: z.coerce.number().int().min(1).max(86_400).default(15 * 60),
  MAILBOX_MEMORY_CLAIM_LEASE_SECONDS: z.coerce.number().int().min(2).max(3_600).default(3_600),
  MAILBOX_MEMORY_SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(60).default(5),
  MODEL_PROVIDER: z.enum(['codex-cli', 'openai', 'anthropic', 'google']).optional(),
  MODEL_NAME: z.string().min(1).optional(),
  MODEL_API_KEY: secret.optional(),
  VAPID_SUBJECT: z.string().startsWith('mailto:'),
  VAPID_PUBLIC_KEY: secret,
  VAPID_PRIVATE_KEY: secret,
  PUSH_SUBSCRIPTION_ENCRYPTION_KEY: z.string().min(32),
  AGENT_GLOBAL_CONSTRAINTS: z.string().min(1).max(20_000),
  ATTACHMENT_TEMP_DIRECTORY: z.string().startsWith('/').refine((value) => value !== '/tmp' && !value.startsWith('/tmp/'), 'must not use shared /tmp'),
  HEALTH_PORT: z.coerce.number().int().min(1024).max(65_535).default(3001),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(60).default(45),
  LIFECYCLE_INTERVAL_SECONDS: positiveInteger.default(3600),
  SHUTDOWN_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(120).default(30),
  BODY_RETENTION_DAYS: positiveInteger.default(90),
  OAUTH_RETENTION_HOURS: positiveInteger.default(24),
  SESSION_RETENTION_DAYS: positiveInteger.default(30),
  TASK_PAYLOAD_RETENTION_DAYS: positiveInteger.default(30),
  OPERATIONAL_TEXT_RETENTION_DAYS: positiveInteger.default(14),
  LIFECYCLE_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
  USER_TASK_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(60),
  USER_TASK_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(4),
  USER_PENDING_TASK_QUOTA: z.coerce.number().int().min(1).max(100_000).default(1_000),
  INCORRECT_MUTATION_THRESHOLD: z.coerce.number().min(0.001).max(0.01).default(0.01),
}).superRefine((environment, context) => {
  if (environment.MAILBOX_MEMORY_RETRY_MAXIMUM_DELAY_SECONDS < environment.MAILBOX_MEMORY_RETRY_BASE_DELAY_SECONDS) {
    context.addIssue({ code: 'custom', path: ['MAILBOX_MEMORY_RETRY_MAXIMUM_DELAY_SECONDS'], message: 'must be greater than or equal to the retry base delay' });
  }
  if (environment.MAILBOX_MEMORY_CLAIM_LEASE_SECONDS * 1_000 <= environment.HINDSIGHT_REQUEST_TIMEOUT_MS) {
    context.addIssue({ code: 'custom', path: ['MAILBOX_MEMORY_CLAIM_LEASE_SECONDS'], message: 'must exceed the Hindsight request timeout' });
  }
  if (environment.MAILBOX_MEMORY_SCHEDULER_INTERVAL_SECONDS >= environment.MAILBOX_MEMORY_CLAIM_LEASE_SECONDS) {
    context.addIssue({ code: 'custom', path: ['MAILBOX_MEMORY_SCHEDULER_INTERVAL_SECONDS'], message: 'must be shorter than the claim lease' });
  }
  if (environment.NODE_ENV !== 'development' && environment.MODEL_PROVIDER === undefined) {
    context.addIssue({ code: 'custom', path: ['MODEL_PROVIDER'], message: 'is required outside development' });
  }
  if (environment.NODE_ENV !== 'development' && environment.MODEL_NAME === undefined) {
    context.addIssue({ code: 'custom', path: ['MODEL_NAME'], message: 'is required outside development' });
  }
  if (environment.MODEL_PROVIDER && environment.MODEL_PROVIDER !== 'codex-cli' && environment.MODEL_API_KEY === undefined) {
    context.addIssue({ code: 'custom', path: ['MODEL_API_KEY'], message: 'is required for hosted model providers' });
  }
}).transform((environment) => ({
  ...environment,
  MODEL_PROVIDER: environment.MODEL_PROVIDER ?? 'codex-cli',
  MODEL_NAME: environment.MODEL_NAME ?? 'default',
}));

export const backupEnvSchema = z.strictObject({
  DATABASE_URL: databaseUrl,
  BACKUP_TARGET: z.string().startsWith('s3://'),
  BACKUP_ENCRYPTION_KEY_FILE: z.string().startsWith('/run/secrets/'),
  BACKUP_STATE_ENCRYPTION_KEY_FILE: z.string().startsWith('/run/secrets/'),
  BACKUP_RETENTION_DAYS: positiveInteger.default(30),
});

export type WebEnv = z.infer<typeof webEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;
export type BackupEnv = z.infer<typeof backupEnvSchema>;

const secretName = /(SECRET|KEY|TOKEN|PASSWORD|DATABASE_URL|HYPERMAIL_TENANT_ROUTES)/i;

export function redactEnvironment(values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, secretName.test(name) ? '[REDACTED]' : value]),
  );
}

export function parseEnvironment<T>(schema: z.ZodType<T>, values: unknown): T {
  const parsed = schema.safeParse(values);
  if (parsed.success) return parsed.data;
  const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? 'environment')))];
  throw new Error(`Invalid environment variables: ${names.join(', ')}`);
}
