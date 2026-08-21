import type { OnboardingAccount } from '@hypermail/hypermail';
import {
  MailboxInputError,
  MailboxUnavailableError,
  type CompleteMailboxInput,
  type CompleteMailboxResult,
  type MailboxOnboardingProvider,
  type MailboxScope,
  type ReadyAccountProjector,
  type StartMailboxInput,
  type StartMailboxResult,
} from './contracts.js';

export type TenantMailboxOnboardingLease = Readonly<{ provider: MailboxOnboardingProvider; release(): Promise<void> }>;
export interface TenantMailboxOnboardingProvider { leaseForUser(userId: string): Promise<TenantMailboxOnboardingLease>; }

/** Explicit owner-only mailbox onboarding. Provider selection is always derived from authenticated User scope. */
export class MailboxService {
  private initialized: Promise<void> | undefined;

  constructor(
    private readonly provider: MailboxOnboardingProvider | TenantMailboxOnboardingProvider,
    private readonly projector: ReadyAccountProjector,
  ) {}

  async start(scope: MailboxScope, input: StartMailboxInput): Promise<StartMailboxResult> {
    this.requireScope(scope);
    try {
      return await this.withProvider(scope.subjectId, async provider => {
        const result = await provider.addAccount(input);
        if (result.status === 'pending') return result;
        return { status: 'ready' as const, account: await this.project(scope.subjectId, result.account) };
      });
    } catch (error) {
      throw this.safeError(error);
    }
  }

  async complete(scope: MailboxScope, input: CompleteMailboxInput): Promise<CompleteMailboxResult> {
    this.requireScope(scope);
    try {
      return await this.withProvider(scope.subjectId, async provider => {
        const result = await provider.completeAddAccount(input);
        if (result.status !== 'ready') return result;
        return { status: 'ready' as const, account: await this.project(scope.subjectId, result.account) };
      });
    } catch (error) {
      throw this.safeError(error);
    }
  }

  private requireScope(scope: MailboxScope): void {
    if (!scope.subjectId.trim()) throw new MailboxInputError();
  }

  private async withProvider<Result>(userId: string, operation: (provider: MailboxOnboardingProvider) => Promise<Result>): Promise<Result> {
    if ('leaseForUser' in this.provider) {
      const lease = await this.provider.leaseForUser(userId);
      try { await lease.provider.initialize(); return await operation(lease.provider); }
      finally { await lease.release(); }
    }
    const provider = this.provider; await this.initializeLegacy(provider); return operation(provider);
  }

  private async initializeLegacy(provider: MailboxOnboardingProvider): Promise<void> {
    if (!this.initialized) {
      this.initialized = provider.initialize().then(() => undefined).catch((error: unknown) => {
        this.initialized = undefined;
        throw error;
      });
    }
    await this.initialized;
  }

  private project(userId: string, account: OnboardingAccount) {
    return this.projector.projectReadyAccount(userId, {
      provider: account.provider,
      email: account.email,
      ...(account.displayName ? { displayName: account.displayName } : {}),
    });
  }

  private safeError(error: unknown): MailboxInputError | MailboxUnavailableError {
    if (error instanceof MailboxInputError || error instanceof MailboxUnavailableError) return error;
    return error instanceof RangeError ? new MailboxInputError() : new MailboxUnavailableError();
  }
}
