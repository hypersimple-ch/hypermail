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

/** Explicit owner-only mailbox onboarding. This service is never composed into worker or agent ports. */
export class MailboxService {
  private initialized: Promise<void> | undefined;

  constructor(
    private readonly provider: MailboxOnboardingProvider,
    private readonly projector: ReadyAccountProjector,
  ) {}

  async start(scope: MailboxScope, input: StartMailboxInput): Promise<StartMailboxResult> {
    this.requireScope(scope);
    try {
      await this.initialize();
      const result = await this.provider.addAccount(input);
      if (result.status === 'pending') return result;
      return { status: 'ready', account: await this.project(scope.subjectId, result.account) };
    } catch (error) {
      throw this.safeError(error);
    }
  }

  async complete(scope: MailboxScope, input: CompleteMailboxInput): Promise<CompleteMailboxResult> {
    this.requireScope(scope);
    try {
      await this.initialize();
      const result = await this.provider.completeAddAccount(input);
      if (result.status !== 'ready') return result;
      return { status: 'ready', account: await this.project(scope.subjectId, result.account) };
    } catch (error) {
      throw this.safeError(error);
    }
  }

  private requireScope(scope: MailboxScope): void {
    if (!scope.subjectId.trim()) throw new MailboxInputError();
  }

  private async initialize(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.provider.initialize().then(() => undefined).catch((error: unknown) => {
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
