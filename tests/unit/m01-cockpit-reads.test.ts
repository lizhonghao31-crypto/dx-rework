// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {JourneyReturnContextSchema,type JourneyResult,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {useCockpitReads} from '../../apps/web/src/cockpit-reads.js';
import {invalidateSession,refreshSession} from '../../apps/web/src/auth-session.js';
type Read=ReturnType<typeof useCockpitReads>;
type Pending={url:URL;resolve:(response:Response)=>void};
const pending:Pending[]=[];let root:Root,host:HTMLDivElement,current:Read,actor='TEST-actor',context=JourneyReturnContextSchema.parse({search:'A',scope:'production'}),refresh=0;
function Probe(){current=useCockpitReads(context,refresh);return null;}
const list=(tag:string):JourneyResult=>({ruleVersion:'journey-v2.0',asOf:'2026-11-05T08:00:00Z',page:1,pageSize:15,total:1,items:[{id:tag} as OrderJourney],summary:{all:1,active:1,notStarted:0,overdue:0,dueSoon:0,blocked:0,completed:0}});
const render=async(patch:Partial<typeof context>={},reload=false)=>{context={...context,...patch};if(reload)refresh++;await act(async()=>root.render(createElement(Probe)));};
const reply=async(index:number,value:unknown,status=200)=>{await act(async()=>pending[index]!.resolve(Response.json(value,{status})));};
beforeEach(async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});invalidateSession();pending.length=0;actor='TEST-actor';refresh=0;context=JourneyReturnContextSchema.parse({search:'A',scope:'production'});
 vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL)=>{const url=new URL(String(input),'http://test.invalid');if(url.pathname.endsWith('/auth/me'))return Promise.resolve(Response.json({status:'authorized',user:{id:actor,displayName:actor,capabilities:['digital_production:view']}}));return new Promise<Response>(resolve=>pending.push({url,resolve}));}));
 host=document.createElement('div');document.body.append(host);root=createRoot(host);await render();
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();invalidateSession();vi.unstubAllGlobals();});
it('rejects A1 and B success/catch/finally after A2, while preserving successful conditions on current-query failure',async()=>{
 expect(pending).toHaveLength(1);await render({search:'B'});await render({search:'A'});expect(pending).toHaveLength(3);
 await reply(2,list('A2'));expect(current.data?.items[0]?.id).toBe('A2');expect(current.applied?.search).toBe('A');
 await reply(0,list('A1'));await reply(1,{error:{message:'TEST old failure'}},503);expect(current.data?.items[0]?.id).toBe('A2');expect(current.listError).toBe('');
 await render({search:'B'});await reply(3,{error:{message:'TEST new failure'}},503);expect(current.data?.items[0]?.id).toBe('A2');expect(current.applied?.search).toBe('A');expect(current.listError).toContain('服务暂时不可用');
});
it('an old finalizer cannot release a newer read; authorization denial clears private results rather than declaring empty',async()=>{
 await reply(0,list('known'));await render({},true);await render({},true);await reply(1,{error:{message:'TEST old retry'}},503);expect(current.listPhase).toBe('loading');expect(current.data?.items[0]?.id).toBe('known');
 await reply(2,{error:{message:'TEST same actor lost scope'}},403);expect(current.listPhase).toBe('error');expect(current.data).toBeNull();expect(current.applied).toBeNull();expect(current.listError).toContain('当前身份无权');
});
it('detail objects never paint under a different selected order or round, including same-order refresh failure',async()=>{
 await render({selected:'Q'});expect(current.detail).toBeNull();const q={id:'Q',sourceId:'Q-source',orderId:'Q-order',stages:[]};await reply(1,q);expect(current.detail?.id).toBe('Q');
 await render({selected:'S'});expect(current.detail).toBeNull();await render({selected:'Q'});expect(current.detail).toBeNull();await reply(3,{...q,sourceVersion:2});await reply(2,{id:'S',stages:[]});expect(current.detail?.sourceVersion).toBe(2);
 await render({},true);await reply(4,{error:{message:'TEST detail unavailable'}},503);expect(current.detail?.sourceVersion).toBe(2);expect(current.detailError).toContain('服务暂时不可用');
 await render({round:2});expect(current.detail).toBeNull();await reply(5,{id:'S',stages:[]});expect(current.detail).toBeNull();expect(current.detailError).toContain('所选对象');
 await render({},true);await reply(6,{...q,selectedRound:1});expect(current.detail).toBeNull();expect(current.detailError).toContain('所选开发轮次');await render({},true);await reply(7,{...q,selectedRound:2});expect(current.detail?.selectedRound).toBe(2);expect(current.detailError).toBe('');
});
it('identity tightening discards previous private data and rejects late responses from the former identity',async()=>{
 await reply(0,list('private-old'));await render({},true);actor='TEST-readonly-new';await act(async()=>{await refreshSession();});expect(current.data).toBeNull();expect(pending).toHaveLength(3);
 await reply(1,list('late-private'));expect(current.data).toBeNull();expect(current.listPhase).toBe('loading');await reply(2,list('new-scope'));expect(current.data?.items[0]?.id).toBe('new-scope');
});
it('an explicit session invalidation re-verifies identity and resumes reading instead of remaining permanently unverified',async()=>{
 await reply(0,list('old'));actor='TEST-next-actor';await act(async()=>{invalidateSession();});expect(current.data).toBeNull();expect(pending).toHaveLength(2);await reply(1,list('reverified'));expect(current.data?.items[0]?.id).toBe('reverified');expect(current.listPhase).toBe('ready');
});
it('a failed identity recheck clears private data and finishes with a retryable error rather than permanent busy',async()=>{
 await reply(0,list('private'));await render({selected:'Q'});vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({error:{message:'TEST登录已失效'}},{status:401})));await act(async()=>{await refreshSession();});expect(current.data).toBeNull();expect(current.detail).toBeNull();expect(current.listPhase).toBe('error');expect(current.detailLoading).toBe(false);expect(current.detailError).toContain('当前登录或读取身份尚未核准');
});
