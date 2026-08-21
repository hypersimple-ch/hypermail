/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { PUBLIC_AGENT_TOOL_CAPABILITY, type PublicAgentTool } from '@hypermail/agent-connections';
import { PublicMcpError, type FinalMutationFence, type InitialAuthorization, type PublicInvocationAuthorizer, type VerifiedInvocationBinding } from './core.js';

type Fact = { token_digest:string; audience:string; scope:string; automatic_processing_enabled:boolean; token_expires_at:Date; token_revoked_at:Date|null; family_expires_at:Date; family_revoked_at:Date|null; client_revoked_at:Date|null; user_id:string; connection_id:string; account_id:string; lifecycle_revision:number; assignment_revision:number; grant_revision:number; safety_revision:number; capabilities:string[]; invocation_modes:string[]; ceiling_capabilities:string[]; ceiling_modes:string[] };

/** Loads one coherent authority fact-set. No bearer material is accepted or persisted here: credentialId is its HMAC digest. */
export class PostgresPublicMcpAuthorization implements PublicInvocationAuthorizer, FinalMutationFence {
  constructor(private readonly sql: Sql, private readonly expectedAudience:string, private readonly now:()=>Date=()=>new Date()) {}
  private async fact(credentialId:string):Promise<Fact|null> {
    const rows=await this.sql<Fact[]>`select t.token_digest,t.audience,t.scope,a.automatic_processing_enabled,t.expires_at token_expires_at,t.revoked_at token_revoked_at,
      f.expires_at family_expires_at,f.revoked_at family_revoked_at,pc.revoked_at client_revoked_at,
      f.user_id,f.connection_id,f.account_id,x.lifecycle_revision,a.revision assignment_revision,g.revision grant_revision,s.revision safety_revision,
      g.capabilities,g.invocation_modes,s.capabilities ceiling_capabilities,s.invocation_modes ceiling_modes
      from app.oauth_tokens t
      join app.oauth_token_families f on f.id=t.family_id
      join app.oauth_public_clients pc on pc.client_id=f.client_id and pc.user_id=f.user_id and pc.agent_connection_id=f.connection_id
      join app.agent_connections x on x.id=f.connection_id and x.user_id=f.user_id and x.state='connected'
      join app.user_accounts ua on ua.user_id=f.user_id and ua.account_id=f.account_id
      join app.mailbox_manager_assignments a on a.user_id=f.user_id and a.account_id=f.account_id and a.manager_kind='agent_connection' and a.agent_connection_id=f.connection_id
      join app.agent_capability_grants g on g.user_id=f.user_id and g.account_id=f.account_id and g.manager_kind='agent_connection' and g.agent_connection_id=f.connection_id and g.state='active'
      cross join app.agent_safety_ceiling s
      where t.token_digest=${credentialId} and t.kind='access'`;
    return rows[0]??null;
  }
  private live(row:Fact):boolean { const now=this.now(); return row.audience===this.expectedAudience&&row.scope==='agent:mailbox'&&!row.token_revoked_at&&!row.family_revoked_at&&!row.client_revoked_at&&row.token_expires_at>now&&row.family_expires_at>now; }
  async authorize(binding:VerifiedInvocationBinding,tool:PublicAgentTool):Promise<InitialAuthorization>{
    const row=await this.fact(binding.principal.credentialId); const capability=PUBLIC_AGENT_TOOL_CAPABILITY[tool];
    const exact=!!row&&this.live(row)&&row.user_id===binding.principal.userId&&row.connection_id===binding.principal.connectionId&&row.account_id===binding.principal.mailboxId&&row.lifecycle_revision===binding.principal.lifecycleRevision&&row.assignment_revision===binding.principal.assignmentRevision&&row.grant_revision===binding.principal.grantRevision&&row.safety_revision===binding.principal.safetyRevision&&row.capabilities.includes(capability)&&row.ceiling_capabilities.includes(capability)&&row.invocation_modes.includes(binding.mode)&&row.ceiling_modes.includes(binding.mode)&&binding.mode==='interactive';
    const decisionId=randomUUID();
    await this.sql`insert into app.audits(actor_type,actor_id,account_id,event,correlation_id,metadata) values('agent_connection',${binding.principal.connectionId},${binding.principal.mailboxId},${exact?'mcp.authorization_allowed':'mcp.authorization_denied'},${decisionId},${JSON.stringify({tool,mode:binding.mode})}::jsonb)`;
    if(!exact||!row) throw new PublicMcpError('forbidden');
    return {decisionId,capability,authority:{authorizationDecisionId:decisionId,credentialId:binding.principal.credentialId,userId:row.user_id,connectionId:row.connection_id,mailboxId:row.account_id,mode:binding.mode,lifecycleRevision:row.lifecycle_revision,assignmentRevision:row.assignment_revision,grantRevision:row.grant_revision,safetyRevision:row.safety_revision,...(binding.signal?{signal:binding.signal}:{})}};
  }
  async stillCurrentAuthority(authority:InitialAuthorization['authority'],capability:string):Promise<boolean>{ return this.stillCurrent({authority,capability,decisionId:'adapter-final-fence'}); }
    async stillCurrent(value:InitialAuthorization):Promise<boolean>{
    const a=value.authority,row=await this.fact(a.credentialId); if(!row||!this.live(row))return false;
    return row.user_id===a.userId&&row.connection_id===a.connectionId&&row.account_id===a.mailboxId&&row.lifecycle_revision===a.lifecycleRevision&&row.assignment_revision===a.assignmentRevision&&row.grant_revision===a.grantRevision&&row.safety_revision===a.safetyRevision&&row.invocation_modes.includes(a.mode)&&row.ceiling_modes.includes(a.mode)&&a.mode==='interactive'&&row.capabilities.includes(value.capability)&&row.ceiling_capabilities.includes(value.capability);
  }
}
