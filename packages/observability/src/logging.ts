export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogRecord = Readonly<{ timestamp: string; level: LogLevel; event: string; correlationId?: string; fields: Readonly<Record<string, unknown>> }>;
export type LogSink = (record: LogRecord) => void;

const SENSITIVE_KEY = /(?:body|message|preview|subject|attachment|filename|cookie|token|secret|password|authorization|database(?:_|-)?url|provider|model|vapid|send|email|sender|recipient|account|user|session|recovery|credential|endpoint)/i;
const URL = /(?:postgres(?:ql)?:\/\/|https?:\/\/)[^\s"']+/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const LONG_SECRET = /(?:[A-Za-z0-9_-]{24,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g;
const EVENT = /^[a-z][a-z0-9._-]{0,79}$/;

function redactText(value: string): string {
  return value.replace(URL, '[redacted-url]').replace(EMAIL, '[redacted-email]').replace(LONG_SECRET, '[redacted]');
}

/** Returns a safe, bounded projection suitable for structured operational logs. */
export function redact(value: unknown, key = '', depth = 0): unknown {
  if (SENSITIVE_KEY.test(key) || depth > 6) return '[redacted]';
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
  if (typeof value === 'string') return redactText(value).slice(0, 512);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, '', depth + 1));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) result[childKey] = redact(childValue, childKey, depth + 1);
    return result;
  }
  return '[unsupported]';
}

const OPERATIONAL_NUMERIC_FIELDS = new Set(['count','value','durationMs','ageSeconds','attempt','limit','statusCode']);
const OPERATIONAL_BOOLEAN_FIELDS = new Set(['healthy','retryable','denied']);
const OPERATIONAL_CATEGORIES: Readonly<Record<string, ReadonlySet<string>>> = {
  queue: new Set(['agent.evaluate','notification.deliver','policy.execute','agent.task']),
  outcome: new Set(['success','failure','retrying','paused','unavailable','denied','observed']),
  dependency: new Set(['database','queue','hypermail','scheduler','model','notifications','policy']),
  providerKind: new Set(['microsoft','gmail','imap','unknown']),
  reasonCode: new Set(['quota','rate_limit','concurrency','authorization','oauth_reuse','provider','invalid_input','unknown']),
};

/** Strict projection: arbitrary strings are never accepted as operational fields. */
export function allowlistedFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key,value] of Object.entries(fields)) {
    if (OPERATIONAL_NUMERIC_FIELDS.has(key) && typeof value === 'number' && Number.isFinite(value)) safe[key]=value;
    else if (OPERATIONAL_BOOLEAN_FIELDS.has(key) && typeof value === 'boolean') safe[key]=value;
    else if (typeof value === 'string' && OPERATIONAL_CATEGORIES[key]?.has(value)) safe[key]=value;
  }
  return safe;
}

function safeCorrelationId(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
}

export function createStructuredLogger(sink: LogSink, now: () => Date = () => new Date()) {
  return {
    log(level: LogLevel, event: string, fields: Readonly<Record<string, unknown>> = {}, correlationId?: string): void {
      const safeCorrelation = safeCorrelationId(correlationId);
      sink({ timestamp: now().toISOString(), level, event: EVENT.test(event) ? event : 'invalid_event', ...(safeCorrelation ? { correlationId: safeCorrelation } : {}), fields: allowlistedFields(fields) });
    },
  };
}
