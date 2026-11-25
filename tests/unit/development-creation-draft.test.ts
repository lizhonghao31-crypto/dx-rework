import {describe,it,expect} from 'vitest';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {clearCreationDraft,listCreationDrafts,readCreationDraft,selectCreationDraft,writeCreationDraft,type CreationDraftRecord,type CreationDraftSnapshot} from '../../apps/web/src/development-creation-draft.js';
import {developmentDraftRows,type SavedDevelopmentDraft} from '../../apps/web/src/development-draft-list.js';

const actorId='11111111-1111-4111-8111-111111111111',viewId='22222222-2222-4222-8222-222222222222',sourceId='33333333-3333-4333-8333-333333333333',identity={actorId,environment:'https://TEST.invalid/acceptance/'};
function storage(){const rows=new Map<string,string>();return {getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);},rows};}
function snapshot():CreationDraftSnapshot{
 const document=initialDevelopmentDocument();document.instructions='  TEST 未完成的原字符串  ';
 return {intent:'certain_order',form:{customerCode:'',productGroup:'男装',designStyleNo:'  TEST 未提交款号  ',temporaryStyleNo:null,orderDate:'2026-11-17',contractDeliveryDate:null,lines:[{poNumber:null,formalStyleNo:null,temporaryStyleNo:null,color:'  黑  ',colorForeign:null,deliveryDate:null,sizes:[{size:'M',quantity:'1.'}]}]},document,quantityInput:'2.',sizeQuantityInputs:[],developmentType:'头版',preorder:false,fixedCraft:true,measurementIds:document.measurements.map((_,index)=>'TEST-row-'+index),poSizeIds:['TEST-po-size'],sharedPoColumns:true,dateOverrides:[],fileKind:'菲林',patternChoice:null,baseline:'TEST original untouched baseline',localFiles:[]};
}
const draft=():CreationDraftRecord=>({schemaVersion:1,viewId,identity,open:true,phase:'draft',snapshot:snapshot()});

describe('single development draft list',()=>{
 const saved:SavedDevelopmentDraft={sourceId,designStyleNo:'TEST-PERSISTED',version:2,updatedAt:'2026-11-25T14:00:00.000Z',approvalState:'pending'};
 const bound:CreationDraftRecord={...draft(),phase:'bound',sourceId,version:1};
 const pending:CreationDraftRecord={...draft(),phase:'pending',sourceId,beforeVersion:1,
  original:{path:`sources/${sourceId}/development`,method:'PUT',key:'TEST-pending-save',body:'{}'}};
 it('merges recovery using immutable source ID and prioritizes the unresolved original without replacing server metadata',()=>{
  const separate={...draft(),viewId:actorId,snapshot:{...snapshot(),form:{...snapshot().form,designStyleNo:saved.designStyleNo!}}};
  expect(developmentDraftRows([saved],[bound,separate,pending],'persisted',1)).toEqual([
   {kind:'saved',saved,local:pending},{kind:'local',local:separate},
  ]);
  expect(developmentDraftRows([saved],[bound],'persisted',2)).toEqual([{kind:'saved',saved,local:bound}]);
 });
 it('filters local drafts with the same submitted search and keeps an unresolved result findable on a later page',()=>{
  const local=draft(),unbound={...pending,sourceId:null,beforeVersion:null,original:{path:'sources/drafts',method:'POST' as const,key:'TEST-pending',body:'{}'}};
  expect(developmentDraftRows([], [local], '  test 未提交 ', 1)).toEqual([{kind:'local',local}]);
  expect(developmentDraftRows([], [local], '无关', 1)).toEqual([]);
  expect(developmentDraftRows([], [local,{...unbound,viewId:actorId}], '无关', 3)).toEqual([{kind:'local',local:{...unbound,viewId:actorId}}]);
 });
});

describe('original designer parent/child pure creation draft storage',()=>{
 it('retains raw incomplete form, document and stable local row identities without inventing source, key, body or version',()=>{
  const store=storage(),record=draft();writeCreationDraft(store,record);expect(readCreationDraft(store,identity)).toEqual(record);
  const value=readCreationDraft(store,identity)!;for(const field of ['sourceId','original','native','version','beforeVersion'])expect(value).not.toHaveProperty(field);expect(value.snapshot.form.lines[0]!.sizes[0]!.quantity).toBe('1.');expect(value.snapshot.document.instructions).toBe('  TEST 未完成的原字符串  ');
 });
 it('scopes storage to fresh current actor/environment and retains unreadable future records instead of treating them as empty',()=>{
  const store=storage(),record=draft();writeCreationDraft(store,record);expect(readCreationDraft(store,{...identity,actorId:sourceId})).toBeNull();expect(readCreationDraft(store,{...identity,environment:'https://TEST.invalid/production/'})).toBeNull();
  const key=[...store.rows.keys()][0]!;store.rows.set(key,JSON.stringify({...record,schemaVersion:99}));expect(()=>readCreationDraft(store,identity)).toThrow();expect(store.rows.has(key)).toBe(true);
 });
 it('never overwrites or clears a pending original from a stale draft/view or unrelated acknowledgement',()=>{
  const store=storage(),record=draft(),original={path:'sources',method:'POST' as const,key:'TEST-original-create',body:JSON.stringify({designStyleNo:'TEST original source'})},pending:CreationDraftRecord={...record,phase:'pending',sourceId:null,beforeVersion:null,original};writeCreationDraft(store,pending);
  expect(()=>writeCreationDraft(store,record)).toThrow('尚未核实');expect(()=>clearCreationDraft(store,identity,viewId)).toThrow('尚未核实');expect(()=>writeCreationDraft(store,{...record,viewId:sourceId})).toThrow('旧回包');
  expect(()=>writeCreationDraft(store,{...record,phase:'bound',sourceId,version:null},{path:'sources',key:'OTHER'})).toThrow('尚未核实');expect(readCreationDraft(store,identity)).toEqual(pending);
  writeCreationDraft(store,{...record,phase:'bound',sourceId,version:null},original);expect(readCreationDraft(store,identity)).toMatchObject({phase:'bound',sourceId,version:null});
 });
 it('keeps only an exact original native publish/confirm command and rejects mismatched path/key/source identity',()=>{
  const record=draft(),command={operation:'publish' as const,sourceId,key:'TEST-native-publish',body:{expectedVersion:2}},original={path:`sources/${sourceId}/development/publish`,method:'POST' as const,key:command.key,body:JSON.stringify(command.body)},pending:CreationDraftRecord={...record,phase:'pending',sourceId,beforeVersion:2,original,native:command};
  const store=storage();writeCreationDraft(store,pending);expect(readCreationDraft(store,identity)).toEqual(pending);
  for(const changed of [{...pending,native:{...command,key:'OTHER'}},{...pending,original:{...original,path:`sources/${actorId}/development/publish`}},{...pending,original:{...original,body:JSON.stringify({expectedVersion:3})}}])expect(()=>writeCreationDraft(storage(),changed)).toThrow();
 });
 it('retains the original unsent draft through a new view and only restores the explicitly selected view',()=>{
  const store=storage(),record=draft();
  writeCreationDraft(store,record);
  expect(()=>selectCreationDraft({...store,setItem:()=>{throw Error('TEST storage full');}},identity)).toThrow('TEST storage full');
  expect(readCreationDraft(store,identity)).toEqual(record);
  selectCreationDraft(store,identity);
  expect(readCreationDraft(store,identity)).toBeNull();
  expect(()=>writeCreationDraft(store,record)).toThrow('旧回包');
  const second={...draft(),viewId:sourceId,snapshot:{...snapshot(),preorder:true}};
  writeCreationDraft(store,second);
  expect(()=>selectCreationDraft(store,identity,actorId)).toThrow('未找到');
  expect(readCreationDraft(store,identity)).toEqual(second);
  expect(selectCreationDraft(store,identity,viewId)).toEqual(record);
  expect(listCreationDrafts(store,identity)).toEqual([record,{...second,open:false}]);
  clearCreationDraft(store,identity,viewId);
  expect(listCreationDrafts(store,identity)).toEqual([{...second,open:false}]);
 });
 it('blocks malformed row/document state and failed durable recording before any command can start',()=>{
  const record=draft(),store=storage();expect(()=>writeCreationDraft(store,{...record,snapshot:{...record.snapshot,measurementIds:[]}})).toThrow('行身份');expect(()=>writeCreationDraft(store,{...record,snapshot:{...record.snapshot,document:{...record.snapshot.document,materials:null as never}}})).toThrow('结构');
  expect(()=>writeCreationDraft({...storage(),setItem:()=>{throw Error('TEST storage unavailable');}},record)).toThrow('TEST storage unavailable');expect(store.rows.size).toBe(0);
  writeCreationDraft(store,record);expect(()=>clearCreationDraft({...store,removeItem:()=>undefined},identity,viewId)).toThrow('尚未确认清理');expect(readCreationDraft(store,identity)).toEqual(record);
 });
});
