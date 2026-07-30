import { z } from 'zod';

const nodeEnv = z.enum(['development', 'test', 'production']).default('development');
const databaseUrl = z.url().startsWith('postgresql://');
const httpsOrigin = z.url().refine(
  (value) => new URL(value).protocol === 'https:',
  'must use https',
);
const secret = z.string().min(16);
const positiveInteger = z.coerce.number().int().positive();

const shared = {
  NODE_ENV: nodeEnv,
  DATABASE_URL: databaseUrl,
};

export const webEnvSchema = z.strictObject({
  ...shared,
  APP_ORIGIN: httpsOrigin,
  AUTH_SECRET: z.string().min(32),
  RECOVERY_RECIPIENT: z.email(),
  HYPERMAIL_URL: z.url(),
  HYPERMAIL_KEY: secret,
  HYPERMAIL_PROTOCOL_VERSION: z.string().min(1),
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
  if ((environment.APPROVED_SEND_URL === undefined) !== (environment.APPROVED_SEND_TOKEN === undefined)) {
    context.addIssue({ code: 'custom', path: ['APPROVED_SEND_URL'], message: 'approved send URL and token must be configured together' });
  }
});

export const workerEnvSchema = z.strictObject({
  ...shared,
  HYPERMAIL_URL: z.url(),
  HYPERMAIL_KEY: secret,
  HYPERMAIL_PROTOCOL_VERSION: z.string().min(1),
  MODEL_PROVIDER: z.enum(['openai', 'anthropic', 'google']),
  MODEL_NAME: z.string().min(1),
  MODEL_API_KEY: secret,
  VAPID_SUBJECT: z.string().startsWith('mailto:'),
  VAPID_PUBLIC_KEY: secret,
  VAPID_PRIVATE_KEY: secret,
  PUSH_SUBSCRIPTION_ENCRYPTION_KEY: z.string().min(32),
  AGENT_GLOBAL_CONSTRAINTS: z.string().min(1).max(20_000),
  HEALTH_PORT: z.coerce.number().int().min(1024).max(65_535).default(3001),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(60).default(45),
  LIFECYCLE_INTERVAL_SECONDS: positiveInteger.default(3600),
  SHUTDOWN_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(120).default(30),
  BODY_RETENTION_DAYS: positiveInteger.default(90),
  INCORRECT_MUTATION_THRESHOLD: z.coerce.number().min(0.001).max(0.01).default(0.01),
});

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

const secretName = /(SECRET|KEY|TOKEN|PASSWORD|DATABASE_URL)/i;

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
