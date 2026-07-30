import { betterAuth } from 'better-auth';
import type { Pool } from 'pg';
import { hashPassword, type RecoveryMailAdapter, verifyPassword } from './index.js';

const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 7;
const RESET_TOKEN_LIFETIME_SECONDS = 60 * 15;

export type BetterAuthFactoryOptions = Readonly<{
  pool: Pool;
  secret: string;
  baseURL: string;
  trustedOrigins?: readonly string[];
  mail: RecoveryMailAdapter;
}>;

/**
 * Builds the Better Auth configuration used by the PostgreSQL-backed auth handler.
 * The application keeps its one-time bootstrap flow in AuthService; Better Auth's
 * public email/password sign-up endpoint is deliberately disabled.
 */
export function createBetterAuthOptions(options: BetterAuthFactoryOptions) {
  const baseURL = secureOrigin(options.baseURL, 'baseURL');
  const trustedOrigins = [...new Set((options.trustedOrigins ?? [baseURL]).map((origin) => secureOrigin(origin, 'trusted origin')))];
  if (!trustedOrigins.includes(baseURL)) trustedOrigins.push(baseURL);

  return {
    database: options.pool,
    secret: options.secret,
    baseURL,
    trustedOrigins,
    user: { modelName: 'auth_users' },
    session: {
      modelName: 'auth_sessions',
      expiresIn: SESSION_LIFETIME_SECONDS,
      updateAge: 60 * 60 * 24,
    },
    account: { modelName: 'auth_accounts' },
    verification: { modelName: 'auth_verifications' },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      password: {
        hash: hashPassword,
        verify: ({ password, hash }: { password: string; hash: string }) => verifyPassword(password, hash),
      },
      sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
        await options.mail.deliver({
          to: user.email,
          resetUrl: url,
          tags: ['recovery', 'exclude-autonomous-ingestion'],
          autonomousIngestionExcluded: true,
        });
      },
      resetPasswordTokenExpiresIn: RESET_TOKEN_LIFETIME_SECONDS,
      revokeSessionsOnPasswordReset: true,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      storage: 'database' as const,
      modelName: 'auth_rate_limits',
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/request-password-reset': { window: 60 * 15, max: 5 },
      },
    },
    advanced: {
      useSecureCookies: true,
      defaultCookieAttributes: {
        httpOnly: true,
        secure: true,
        sameSite: 'lax' as const,
      },
    },
  };
}

/** Creates a real Better Auth instance backed by the supplied PostgreSQL pg.Pool. */
export function createBetterAuth(options: BetterAuthFactoryOptions) {
  return betterAuth(createBetterAuthOptions(options));
}

/** Framework-neutral Fetch handler; mount it in any Request/Response-capable server. */
export function createBetterAuthHandler(options: BetterAuthFactoryOptions) {
  return createBetterAuth(options).handler;
}

function secureOrigin(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${label} must be an HTTPS origin without a path, query, or fragment`);
  }
  return url.origin;
}
