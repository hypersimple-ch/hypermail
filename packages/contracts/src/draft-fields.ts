import { z } from 'zod';

export const recipientSchema = z.strictObject({ kind: z.enum(['to', 'cc', 'bcc']), address: z.email() });
export const draftFieldsSchema = z.strictObject({
  recipients: z.array(recipientSchema).max(100),
  subject: z.string().max(998),
  body: z.string().max(2_000_000),
  bodyFormat: z.enum(['markdown', 'html']),
});

export type Recipient = z.infer<typeof recipientSchema>;
export type DraftFields = z.infer<typeof draftFieldsSchema>;
export type DraftBodyFormat = DraftFields['bodyFormat'];

export function recipientProblem(recipients: readonly Recipient[]): string | null {
  if (!recipients.some((recipient) => recipient.kind === 'to')) return 'At least one To recipient is required.';
  const seen = new Set<string>();
  for (const recipient of recipients) {
    const key = recipient.address.toLowerCase();
    if (seen.has(key)) return 'Each recipient address may appear only once.';
    seen.add(key);
  }
  return null;
}

export const agentDraftFieldsSchema = draftFieldsSchema.extend({ bodyFormat: z.literal('markdown') }).superRefine((draft, context) => {
  const problem = recipientProblem(draft.recipients);
  if (problem) context.addIssue({ code: 'custom', path: ['recipients'], message: problem });
});
