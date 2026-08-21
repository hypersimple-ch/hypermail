import { describe,expect,it } from 'vitest';
import { oauthAudience,pkceS256 } from '../src/oauth/service.js';
import { parseFormEncoded } from '../src/oauth/routes.js';
describe('OAuth primitives',()=>{it('matches RFC 7636 S256 vector',()=>{expect(pkceS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');});it('uses canonical configured audience',()=>{expect(oauthAudience('https://mail.example')).toBe('https://mail.example/mcp');});it('bounds strict form parser',()=>{expect(parseFormEncoded(Buffer.from('grant_type=refresh_token&client_id=x'))).toEqual({grant_type:'refresh_token',client_id:'x'});expect(()=>{parseFormEncoded(Buffer.from('a=1&a=2'));}).toThrow();expect(()=>{parseFormEncoded(Buffer.alloc(8193));}).toThrow();});});
