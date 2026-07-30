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

export function createStructuredLogger(sink: LogSink, now: () => Date = () => new Date()) {
  return {
    log(level: LogLevel, event: string, fields: Readonly<Record<string, unknown>> = {}, correlationId?: string): void {
      sink({ timestamp: now().toISOString(), level, event: EVENT.test(event) ? event : 'invalid_event', ...(correlationId ? { correlationId } : {}), fields: redact(fields) as Record<string, unknown> });
    },
  };
}
