import type { AgentTaskStore } from '@hypermail/db';
import { describe,expect,it,vi } from 'vitest';
import { ExternalAgentTaskProtocol,MastraAutomaticTaskAdapter } from '../src/agent-task-delivery.js';

describe('automatic Task adapters',()=>{
  it('external claims are pinned to the authenticated connection and forward fenced results',async()=>{
    const claim=vi.fn().mockResolvedValue(null); const task={claim,reportResult:vi.fn()} as unknown as AgentTaskStore;
    const protocol=new ExternalAgentTaskProtocol(task);
    await protocol.claim('00000000-0000-4000-8000-000000000001','worker','2026-01-01T00:00:00.000Z');
    expect(claim).toHaveBeenCalledWith({kind:'agent_connection',connectionId:'00000000-0000-4000-8000-000000000001'},'worker','2026-01-01T00:00:00.000Z');
  });
  it('Mastra asks only for the mastra target and never falls back to an external claim',async()=>{
    const claim=vi.fn().mockResolvedValue(null); const tasks={claim} as unknown as AgentTaskStore;
    const adapter=new MastraAutomaticTaskAdapter(tasks,{execute:vi.fn()},'embedded');
    expect(await adapter.runOne('2026-01-01T00:00:00.000Z')).toBe(false);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith({kind:'mastra'},'embedded','2026-01-01T00:00:00.000Z');
  });
});
