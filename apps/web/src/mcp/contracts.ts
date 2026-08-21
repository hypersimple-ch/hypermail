import { z } from 'zod';

const opaqueId = z.string().trim().min(1).max(512);
const cursor = z.string().min(1).max(2_048);
const address = z.strictObject({ address: z.email().max(320), name: z.string().trim().min(1).max(200).optional() });
const messageSummary = z.strictObject({
  id: opaqueId, subject: z.string().max(998).optional(), from: address.optional(), receivedAt: z.iso.datetime().optional(),
  isRead: z.boolean().optional(), folderId: opaqueId.optional(), hasAttachments: z.boolean(),
});
const attachment = z.strictObject({ id: opaqueId, name: z.string().min(1).max(500), contentType: z.string().max(255).optional(), size: z.number().int().nonnegative().max(25_000_000).optional() });
const recipients = z.strictObject({ to: z.array(address).min(1).max(100), cc: z.array(address).max(100).optional(), bcc: z.array(address).max(100).optional() });
const draftFields = recipients.extend({ subject: z.string().max(998), body: z.string().max(2_000_000) }).strict();
const messageMutation = z.strictObject({ messageId: opaqueId, status: z.enum(['archived', 'trashed_recoverable', 'moved', 'read', 'unread']) });
const draftResult = z.strictObject({ draftId: z.uuid(), version: z.number().int().positive(), state: z.enum(['editing', 'ready']) });

export const publicToolContracts = {
  list_emails: {
    args: z.strictObject({ folderId: opaqueId.optional(), cursor: cursor.optional(), limit: z.number().int().min(1).max(100).default(25) }),
    result: z.strictObject({ messages: z.array(messageSummary).max(100), nextCursor: cursor.optional() }),
  },
  search_emails: {
    args: z.strictObject({ query: z.string().trim().min(1).max(500), from: z.email().max(320).optional(), to: z.email().max(320).optional(), cursor: cursor.optional(), limit: z.number().int().min(1).max(100).default(25) }),
    result: z.strictObject({ messages: z.array(messageSummary).max(100), nextCursor: cursor.optional() }),
  },
  read_email: {
    args: z.strictObject({ messageId: opaqueId, format: z.enum(['markdown', 'text']).default('markdown') }),
    result: messageSummary.extend({ to: z.array(address).max(100).optional(), cc: z.array(address).max(100).optional(), body: z.string().max(2_000_000), bodyFormat: z.enum(['markdown', 'text']), attachments: z.array(attachment).max(100) }).strict(),
  },
  read_attachment: {
    args: z.strictObject({ messageId: opaqueId, attachmentId: opaqueId }),
    result: attachment.extend({ encoding: z.literal('base64'), content: z.string().max(33_333_336) }).strict(),
  },
  list_folders: {
    args: z.strictObject({}),
    result: z.strictObject({ folders: z.array(z.strictObject({ id: opaqueId, displayName: z.string().min(1).max(500), parentFolderId: opaqueId.optional() })).max(500) }),
  },
  archive_email: { args: z.strictObject({ messageId: opaqueId }), result: messageMutation },
  trash_email: { args: z.strictObject({ messageId: opaqueId }), result: messageMutation },
  move_email: { args: z.strictObject({ messageId: opaqueId, destinationFolderId: opaqueId }), result: messageMutation },
  mark_read: { args: z.strictObject({ messageId: opaqueId }), result: messageMutation },
  mark_unread: { args: z.strictObject({ messageId: opaqueId }), result: messageMutation },
  draft_email: { args: draftFields, result: draftResult },
  edit_draft: { args: draftFields.partial().extend({ draftId: z.uuid(), expectedVersion: z.number().int().positive() }).strict().refine((value) => ['to', 'cc', 'bcc', 'subject', 'body'].some((field) => field in value), 'At least one draft field is required.') , result: draftResult },
  request_send_email: {
    args: z.strictObject({ draftId: z.uuid(), expectedVersion: z.number().int().positive() }),
    result: z.strictObject({ requestId: z.uuid(), draftId: z.uuid(), state: z.literal('pending_owner_approval'), expiresAt: z.iso.datetime() }),
  },
} as const;

export type PublicToolName = keyof typeof publicToolContracts;
export type PublicToolArgs<Name extends PublicToolName> = z.input<(typeof publicToolContracts)[Name]['args']>;
export type PublicToolResult<Name extends PublicToolName> = z.output<(typeof publicToolContracts)[Name]['result']>;
