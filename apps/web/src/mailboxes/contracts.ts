import type {
  AddAccountInput,
  AddAccountResult,
  CompleteAddAccountInput,
  CompleteAddAccountResult,
  AccountVerification,
} from '@hypermail/hypermail';
import type { AccountProjection, ReadyAccountInput } from '@hypermail/db';

export type MailboxScope = Readonly<{ subjectId: string }>;

export interface MailboxOnboardingProvider {
  initialize(): Promise<unknown>;
  addAccount(input: AddAccountInput): Promise<AddAccountResult>;
  completeAddAccount(input: CompleteAddAccountInput): Promise<CompleteAddAccountResult>;
}

export interface ReadyAccountProjector {
  projectReadyAccount(userId: string, input: ReadyAccountInput): Promise<AccountProjection>;
}

export type StartMailboxInput = AddAccountInput;
export type CompleteMailboxInput = CompleteAddAccountInput;
export type StartMailboxResult =
  | Readonly<{ status: 'pending'; handle: string; verification: AccountVerification }>
  | Readonly<{ status: 'ready'; account: AccountProjection }>;
export type CompleteMailboxResult =
  | Readonly<{ status: 'pending' | 'expired' | 'error' }>
  | Readonly<{ status: 'ready'; account: AccountProjection }>;

export class MailboxInputError extends Error {
  constructor() { super('Invalid mailbox request.'); }
}

export class MailboxUnavailableError extends Error {
  constructor() { super('Mailbox provider is unavailable.'); }
}
