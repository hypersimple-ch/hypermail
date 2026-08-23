import { z } from 'zod';
import type { DraftScope } from '../drafts/contracts.js';
export const sendRequestStateSchema = z.enum(['pending_owner_approval','expired','cancelled','rejected','sending','approved','failed','unverifiable']);
export type SendRequestState = z.infer<typeof sendRequestStateSchema>;
export type OwnerSendRequest = Readonly<{ id:string; accountId:string; draftId:string; draftVersion:number; state:SendRequestState; approvalId:string|null; actionId:string|null; providerMessageId:string|null; expiresAt:string; completedAt:string|null; reasonCode:string|null; createdAt:string; updatedAt:string }>;
export type OwnerSendScope = DraftScope;
export class SendRequestNotFoundError extends Error { constructor(){super('Send request not found.');this.name='SendRequestNotFoundError';} }
export class SendRequestConflictError extends Error { constructor(message='Send request is no longer actionable.'){super(message);this.name='SendRequestConflictError';} }
export class SendRequestFreshAuthError extends Error { constructor(){super('Recent authentication is required.');this.name='SendRequestFreshAuthError';} }
export type SendClaim = Readonly<{ request:OwnerSendRequest; approvalId:string; idempotencyKey:string; message:{accountId:string;draftId:string;draftVersion:number;recipients:readonly {kind:'to'|'cc'|'bcc';address:string}[];subject:string;body:string;bodyFormat:'markdown'|'html'} }>;
