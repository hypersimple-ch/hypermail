import { describe,expect,it,vi } from 'vitest';
import { OwnerSendRequestService, SendRequestFreshAuthError } from '../../src/send-requests/index.js';
import type { MailSendProvider } from '@hypermail/send';
const id='00000000-0000-4000-8000-000000000001';
describe('owner send fresh authentication',()=>{
 it('refuses stale begin and confirm before consuming approval or contacting provider',async()=>{
  const repository={begin:vi.fn(),claim:vi.fn()};const submit=vi.fn();const provider:MailSendProvider={submit,status:vi.fn()};
  const service=new OwnerSendRequestService(repository as never,provider,()=>new Date('2025-01-01T00:10:00.001Z'));
  const scope={subjectId:id,accountIds:[id],freshAuthAt:'2025-01-01T00:00:00.000Z'};
  await expect(service.begin(scope,id,1,'x'.repeat(16))).rejects.toBeInstanceOf(SendRequestFreshAuthError);
  await expect(service.confirm(scope,id,id,'x'.repeat(16))).rejects.toBeInstanceOf(SendRequestFreshAuthError);
  expect(repository.begin).not.toHaveBeenCalled();expect(repository.claim).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled();
 });
});
