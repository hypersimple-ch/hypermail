import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { PUBLIC_AGENT_TOOL_CAPABILITY, type PublicAgentTool } from '@hypermail/agent-connections';
import { publicToolContracts, type PublicToolName } from './contracts.js';

export type PublicToolDefinition<Name extends PublicToolName = PublicToolName> = Readonly<{
  name: Name; title: string; description: string; capability: (typeof PUBLIC_AGENT_TOOL_CAPABILITY)[Name];
  annotations: ToolAnnotations; args: (typeof publicToolContracts)[Name]['args']; result: (typeof publicToolContracts)[Name]['result'];
}>;
const descriptions: Record<PublicToolName, readonly [string, string]> = {
  list_emails: ['List emails', 'List a bounded page of messages in the authorized mailbox.'],
  search_emails: ['Search emails', 'Search messages in the authorized mailbox.'], read_email: ['Read email', 'Read one message.'],
  read_attachment: ['Read attachment', 'Read one bounded message attachment.'], list_folders: ['List folders', 'List mailbox folders.'],
  archive_email: ['Archive email', 'Archive one message.'], trash_email: ['Trash email', 'Move one message to recoverable trash.'],
  move_email: ['Move email', 'Move one message to an existing folder.'], mark_read: ['Mark read', 'Mark one message read.'],
  mark_unread: ['Mark unread', 'Mark one message unread.'], draft_email: ['Create draft', 'Create an app draft without sending it.'],
  edit_draft: ['Edit draft', 'Edit an app draft using optimistic versioning.'], request_send_email: ['Request send', 'Create a pending owner approval request; this never sends mail.'],
};
const readOnly = new Set<PublicToolName>(['list_emails', 'search_emails', 'read_email', 'read_attachment', 'list_folders']);
const destructive = new Set<PublicToolName>(['archive_email', 'trash_email', 'move_email']);

const names = Object.keys(publicToolContracts) as PublicToolName[];
export const publicToolRegistry = Object.fromEntries(names.map((name) => [name, {
  name, title: descriptions[name][0], description: descriptions[name][1], capability: PUBLIC_AGENT_TOOL_CAPABILITY[name],
  annotations: { title: descriptions[name][0], readOnlyHint: readOnly.has(name), destructiveHint: destructive.has(name), idempotentHint: !['draft_email', 'request_send_email'].includes(name), openWorldHint: false },
  args: publicToolContracts[name].args, result: publicToolContracts[name].result,
}])) as { readonly [Name in PublicToolName]: PublicToolDefinition<Name> };

// Both directions intentionally fail compilation if either explicit public list drifts.
type MissingFacadeTool = Exclude<PublicAgentTool, PublicToolName>;
type ExtraFacadeTool = Exclude<PublicToolName, PublicAgentTool>;
const noMissingTool: [MissingFacadeTool] extends [never] ? true : never = true;
const noExtraTool: [ExtraFacadeTool] extends [never] ? true : never = true;
void noMissingTool; void noExtraTool;
export const PUBLIC_MCP_RESOURCE_PATH = '/mcp' as const;
export const PUBLIC_MCP_PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp' as const;
