import {expect,it} from 'vitest';
import {JOURNEY_STAGES,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {COCKPIT_DOCUMENT_CATEGORIES,createCockpitDocumentSnapshot,loadCockpitDirectoryPages,type CockpitDocumentReader} from '../../apps/web/src/cockpit-documents-model.js';
const sid='00000000-0000-4000-8000-000000000001',oid='00000000-0000-4000-8000-000000000002';
const fixture=():OrderJourney=>({id:sid,sourceId:sid,orderId:oid,designStyleNo:'TEST-SNAPSHOT',temporaryStyleNo:null,customer:'TEST',category:null,designer:null,styleName:null,merchandisers:[],orderNumbers:[],createdAt:'2026-10-19T00:00:00Z',deliveryDate:null,selectedRound:1,adoptedRound:1,sourceVersion:1,instructionVersion:0,lines:[],links:[],stages:JOURNEY_STAGES.map(stage=>({...stage,state:'uncreated',nodes:[]})),progress:{development:null,bulk:null},hitReasons:[]});
const metadata=(path:string):unknown=>{
 if(path.endsWith('/execution'))return {tasks:[],facts:[],routeFacts:[]};
 if(path.endsWith('/development/rounds'))return {rounds:[]};
 if(path.includes('/development'))return {sourceId:sid,roundNumber:1,version:1,status:'draft',document:{files:[]}};
 if(path.startsWith('pattern-room/related-orders'))return {items:[],nextPage:null};
 if(path.endsWith('/instruction'))return {order:{productionOrderId:oid},version:0,versions:[],document:null,dateRequests:[]};
 if(path.endsWith('/budget'))return {productionOrderId:oid,version:0,versions:[],document:null};
 if(path.endsWith('/bulk-preparation'))return {orderId:oid,preparationId:null,facts:[],tasks:[],materials:{history:[]},fabric:{report:null,decision:null,usable:false}};
 if(path.endsWith('/factory-flow'))return {orderId:oid,preparationId:null,facts:[],checks:[],shipSamples:[],productionInspectionHistory:[],productionChecks:[]};
 if(path.endsWith('/qc-progress'))return {orderId:oid,executions:[],archivedExecutions:[]};
 if(path.endsWith('/quotation'))return {quoteId:null,resource:{kind:path.includes('/sources/')?'source':'order',id:path.includes('/sources/')?sid:oid},version:0,versions:[],rows:[],fullCost:true};
 if(path.includes('/technical/history'))return {sourceId:sid,roundNumber:1,scopeRef:'整款',items:[],nextBeforeVersion:null,effective:null,contextAvailable:false,adoptedArtifact:null};
 if(path.endsWith('/closure'))return {orderId:oid,lines:[],closed:null};
 if(path===`digital-production/orders/${oid}`)return {productionOrderId:oid,version:1,lines:[]};
 throw Error(`Unexpected original reader ${path}`);
};
const signal=()=>new AbortController().signal;
const related=(page:number)=>`pattern-room/related-orders?sourceId=${sid}&orderId=${oid}&page=${page}`;
const pause=()=>new Promise<void>(resolve=>setTimeout(resolve,1));
it('preloads authorized source metadata with the original three-GET bound with at most three GETs and shares original metadata without reading files',async()=>{
 const calls:string[]=[];let active=0,peak=0;const read:CockpitDocumentReader=async path=>{calls.push(path);active++;peak=Math.max(peak,active);await pause();active--;return metadata(path);};
 const snapshot=createCockpitDocumentSnapshot(fixture(),read);await Promise.all(COCKPIT_DOCUMENT_CATEGORIES.map(({key})=>snapshot.load(key)));
 expect(peak).toBe(3);expect(calls.filter(path=>path.startsWith('pattern-room/related-orders'))).toHaveLength(1);expect(calls.filter(path=>path.endsWith('/instruction'))).toHaveLength(1);
 expect(calls.some(path=>path.includes('/attachments/')||path.includes('?round=')||path.includes('?version='))).toBe(false);
 expect(snapshot.getSnapshot().development.data).toMatchObject({state:'created',entries:[{label:expect.stringContaining('草稿')}]});
 expect(snapshot.getSnapshot().budget.data?.state).toBe('missing');expect(snapshot.getSnapshot().contract.data?.state).toBe('unknown');expect(snapshot.getSnapshot().cutting.data?.state).toBe('unknown');
 const count=calls.length;await snapshot.load('development');expect(calls).toHaveLength(count);
 const entry=snapshot.getSnapshot().development.data!.entries[0]!;await snapshot.loadEntry(entry,signal());expect(calls.some(path=>path.endsWith('?round=1'))).toBe(true);snapshot.dispose();
});
it('distinguishes an absent business source from an uncreated authorized document without making requests',async()=>{
 const snapshot=createCockpitDocumentSnapshot({...fixture(),sourceId:null,orderId:null},async()=>{throw Error('must not read');});await Promise.all(COCKPIT_DOCUMENT_CATEGORIES.map(({key})=>snapshot.load(key)));
 expect(snapshot.getSnapshot().development.data?.state).toBe('not_applicable');expect(snapshot.getSnapshot().pattern.data?.state).toBe('not_applicable');expect(snapshot.getSnapshot().budget.data?.state).toBe('not_applicable');snapshot.dispose();
});
it('does not declare a kind missing until all pages are read, bounds each read and deduplicates real entry IDs',async()=>{
 const calls:string[]=[];const read:CockpitDocumentReader=async path=>{calls.push(path);const page=Number(new URL(path,'http://test').searchParams.get('page'));return {items:page===2?[{kind:'misc',orderId:'misc-1',orderNo:'TEST杂事',rounds:[]}]:page>=4?[{kind:'pattern',orderId:'pattern-1',orderNo:'TEST打板',rounds:[]}]:[],nextPage:page<5?page+1:null};};
 const snapshot=createCockpitDocumentSnapshot(fixture(),read);await snapshot.load('pattern');expect(calls).toEqual([related(1),related(2),related(3)]);expect(snapshot.getSnapshot().pattern.data).toMatchObject({state:'unknown',entries:[],nextPage:4});
 await snapshot.load('pattern',true);expect(snapshot.getSnapshot().pattern.data).toMatchObject({state:'created',entries:[{id:'pattern-1'}],nextPage:null});expect(calls).toHaveLength(5);snapshot.dispose();
});
it('rejects a looping page response instead of presenting an empty directory',async()=>{
 await expect(loadCockpitDirectoryPages(fixture(),'pattern',async()=>({items:[],nextPage:1}),signal())).rejects.toThrow('分页未前进');
});
it('isolates permission, ambiguous 404 and service errors and rechecks only the failed directory',async()=>{
 const failures=new Map([['/budget',403],['/bulk-preparation',503],['/factory-flow',404]]),calls:string[]=[];const read:CockpitDocumentReader=async path=>{calls.push(path);for(const [suffix,status] of failures)if(path.endsWith(suffix))throw Object.assign(new Error('TEST服务拒绝'),{status});return metadata(path);};
 const snapshot=createCockpitDocumentSnapshot(fixture(),read);await Promise.all(COCKPIT_DOCUMENT_CATEGORIES.map(({key})=>snapshot.load(key)));
 expect(snapshot.getSnapshot().budget).toMatchObject({phase:'error',denied:true});expect(snapshot.getSnapshot().budget.data).toBeUndefined();expect(snapshot.getSnapshot().factory).toMatchObject({phase:'error',error:expect.stringContaining('无法确认')});expect(snapshot.getSnapshot().preparation.phase).toBe('error');expect(snapshot.getSnapshot().order.data?.state).toBe('created');
 const prior=calls.length;failures.delete('/budget');await snapshot.load('budget');expect(calls.slice(prior)).toEqual([`digital-production/orders/${oid}/budget`]);expect(snapshot.getSnapshot().budget.data?.state).toBe('missing');snapshot.dispose();
});
it('evicts successful HTTP responses that fail validation so retry can recover instead of replaying malformed cached metadata',async()=>{
 let malformed=true,count=0;const snapshot=createCockpitDocumentSnapshot(fixture(),async path=>{count++;return malformed?{version:0}:metadata(path);});await snapshot.load('budget');expect(snapshot.getSnapshot().budget.phase).toBe('error');malformed=false;await snapshot.load('budget');expect(count).toBe(2);expect(snapshot.getSnapshot().budget.data?.state).toBe('missing');snapshot.dispose();
});
it('retries invalid original records and refuses cached records after the authorizing snapshot changes',async()=>{
 const order=fixture();let current=true,reads=0;
 const snapshot=createCockpitDocumentSnapshot(order,async()=>({orderId:++reads===1?'wrong-order':oid}),()=>current);
 const path=`digital-production/orders/${oid}/receipt-summary?documentBindings=true`;
 const check=(value:unknown)=>{
  expect(value).toEqual({orderId:oid});
  return value;
 };
 await expect(snapshot.readChecked(path,signal(),check)).rejects.toThrow();
 await expect(snapshot.readChecked(path,signal(),check)).resolves.toEqual({orderId:oid});
 await expect(snapshot.readChecked(path,signal(),check)).resolves.toEqual({orderId:oid});
 current=false;
 await expect(snapshot.readChecked(path,signal(),check)).rejects.toMatchObject({name:'AbortError'});
 expect(reads).toBe(2);
 snapshot.dispose();
});
it('rejects metadata for a different source or order without showing its entries',async()=>{
 const read:CockpitDocumentReader=async path=>path.includes('/development/rounds')?{rounds:[]}:path.includes('/development')?{sourceId:'another-source',version:1,document:{}}:{productionOrderId:'another-order',version:1,versions:[1]};
 const snapshot=createCockpitDocumentSnapshot(fixture(),read);await snapshot.load('development');await snapshot.load('budget');expect(snapshot.getSnapshot().development).toMatchObject({phase:'error',error:expect.stringContaining('本单不一致')});expect(snapshot.getSnapshot().budget.data).toBeUndefined();snapshot.dispose();
});
it('does not cache a historical-version fallback as the requested original',async()=>{
 let correct=false,count=0;const snapshot=createCockpitDocumentSnapshot(fixture(),async()=>{count++;return {order:{productionOrderId:oid},version:correct?2:7,document:{images:[]}};});const entry={id:'published:2',label:'已发布 v2',load:{kind:'instruction',path:`digital-production/orders/${oid}/instruction?version=2`,id:oid,version:2}};
 await expect(snapshot.loadEntry(entry,signal())).rejects.toThrow('所选历史版本');correct=true;await expect(snapshot.loadEntry(entry,signal())).resolves.toMatchObject({id:'published:2'});expect(count).toBe(2);snapshot.dispose();
});
it('disposes queued and late replies on identity/snapshot change and never commits their data',async()=>{
 let release!:()=>void;const delayed=new Promise<void>(resolve=>{release=resolve;});let current=true,started=0;const snapshot=createCockpitDocumentSnapshot(fixture(),async path=>{started++;await delayed;return metadata(path);},()=>current);
 const pending=COCKPIT_DOCUMENT_CATEGORIES.map(({key})=>snapshot.load(key));expect(started).toBe(3);current=false;snapshot.dispose();release();await Promise.all(pending);expect(Object.values(snapshot.getSnapshot()).every(state=>state.phase==='idle')).toBe(true);expect(started).toBe(3);
 const fresh=createCockpitDocumentSnapshot(fixture(),async path=>metadata(path));await fresh.load('budget');expect(fresh.getSnapshot().budget.data?.state).toBe('missing');fresh.dispose();
});
it('freezes the source identity for a snapshot instead of accepting in-place parent mutations',async()=>{
 const order=fixture(),calls:string[]=[],snapshot=createCockpitDocumentSnapshot(order,async path=>{calls.push(path);return metadata(path);});order.sourceId='wrong';order.orderId='wrong';await snapshot.load('development');expect(calls[0]).toContain(sid);expect(snapshot.getSnapshot().development.phase).toBe('ready');snapshot.dispose();
});

it.each([
 ['pattern',{items:null,nextPage:null}],['pattern',{items:{},nextPage:null}],['pattern',{items:[null],nextPage:null}],
 ['pattern',{items:[],nextPage:'2'}],['pattern',{items:[],nextPage:0}],['pattern',{items:[],nextPage:1.5}],
 ['pattern',{items:[{kind:'pattern',orderId:7,orderNo:'TEST',rounds:[]}],nextPage:null}],
 ['pattern',{items:[{kind:'pattern',orderId:'TEST',orderNo:'TEST',rounds:null}],nextPage:null}],
 ['pattern',{items:[{kind:'pattern',orderId:'TEST',orderNo:'TEST',rounds:[{roundId:'r',roundType:'initial',roundIndex:'0'}]}],nextPage:null}],
 ['budget',{productionOrderId:oid,version:0,versions:null}],['budget',{productionOrderId:oid,version:0,versions:['1']}],
 ['budget',{productionOrderId:oid,version:'0',versions:[]}],['order',{productionOrderId:oid,lines:null}],
 ['development',{sourceId:sid,version:0,document:'bad'}],['preparation',{orderId:oid,preparationId:false}],
 ['preparation',{orderId:oid,preparationId:'p',facts:[],tasks:[null]}],
 ['factory',{orderId:oid,preparationId:'p',facts:null,checks:[]}],['receiving',{orderId:oid,lines:null,closed:null}],
 ['receiving',{orderId:oid,lines:[],closed:false}],
] as const)('keeps malformed %s metadata out of the existence cache and recovers through the original reader',async(key,bad)=>{
 let invalid=true,count=0;const snapshot=createCockpitDocumentSnapshot(fixture(),async path=>{count++;if(!invalid)return metadata(path);if(key==='order'&&path.endsWith('/instruction'))return metadata(path);if(key==='development'&&path.endsWith('/rounds'))return metadata(path);return bad;});
 await snapshot.load(key);expect(snapshot.getSnapshot()[key]).toMatchObject({phase:'error'});expect(snapshot.getSnapshot()[key].data).toBeUndefined();const prior=count;invalid=false;await snapshot.load(key);expect(count).toBeGreaterThan(prior);expect(snapshot.getSnapshot()[key].phase).toBe('ready');snapshot.dispose();
});
it('validates development revision and contract collections including each entry before deriving missing',async()=>{
 const source=fixture();source.links=[{domain:'sourcing',id:'case',url:'/ui/sourcing/orders/case',mode:'read',version:1,lineId:null}];
 for(const bad of [{rounds:null},{rounds:[null]},{rounds:[{roundNumber:'2'}]}]){const snapshot=createCockpitDocumentSnapshot(source,async path=>path.endsWith('/rounds')?bad:metadata(path));await snapshot.load('development');expect(snapshot.getSnapshot().development.phase).toBe('error');snapshot.dispose();}
 for(const bad of [{contracts:null,versions:[]},{contracts:[],versions:[null]},{contracts:[{entryId:7,version:1}],versions:[]},{contracts:[],versions:[{revision:1,signedContractDocumentId:null,attachments:null}]}]){let invalid=true;const snapshot=createCockpitDocumentSnapshot(source,async()=>invalid?bad:{contracts:[],versions:[]});await snapshot.load('contract');expect(snapshot.getSnapshot().contract).toMatchObject({phase:'error'});invalid=false;await snapshot.load('contract');expect(snapshot.getSnapshot().contract.data?.state).toBe('missing');snapshot.dispose();}
});
it('drops a malformed late reply after switching orders without replacing the new valid existence result',async()=>{
 let release!:(value:unknown)=>void;const old=createCockpitDocumentSnapshot(fixture(),async()=>new Promise(resolve=>{release=resolve;}));const pending=old.load('pattern');await pause();old.dispose();const next=createCockpitDocumentSnapshot({...fixture(),sourceId:'next'},async()=>({items:[],nextPage:null}));await next.load('pattern');release({items:null,nextPage:null});await pending;expect(old.getSnapshot().pattern.phase).toBe('idle');expect(next.getSnapshot().pattern).toMatchObject({phase:'ready',data:{state:'missing'}});next.dispose();
});
