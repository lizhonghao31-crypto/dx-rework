import {describe,it,expect} from 'vitest';
import type {InstructionDocument} from '@dx-rework/contracts/production-instruction';
import {emptyInstructionRecovery,instructionDecisionEnvelope,instructionEnvelopeRequestBody,instructionPayloadHash,instructionReceiptMatches,instructionReceiptReadPath,instructionRecoveryCommandIdentity,instructionRecoveryKey,instructionSaveEnvelope,readInstructionRecovery,settleInstructionRecovery,writeInstructionRecovery} from '../../apps/web/src/instruction-recovery-state.js';

const actorId='11111111-1111-4111-8111-111111111111',orderId='22222222-2222-4222-8222-222222222222',requestId='33333333-3333-4333-8333-333333333333',identity={environment:'https://TEST.invalid/acceptance/',actorId,orderId};
const document:InstructionDocument={styleName:'  TEST原字符串  ',category:'',season:'',fabricType:'',composition:'',date:null,process:'',secondaryCraft:'沿用开发',remarks:'  未完成  ',patternMaker:'',preshrink:'待确认',shipSample:'',sewingRequirements:'',comments:'',fabrics:[],accessories:[],images:[],unit:'cm',sizes:[],measurements:[]};
const body={expectedVersion:2,orderVersion:3,sourceRound:1,document};
function storage(){const rows=new Map<string,string>();return {getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);},rows};}
const draft=(generation=1)=>({document:structuredClone(document),generation,expectedVersion:2,orderVersion:3,sourceRound:1});

describe('same-tab original instruction recovery envelope and raw draft',()=>{
 it('separates current actor, object and deployment environment without storing roles or credentials',async()=>{
  const store=storage(),state={...emptyInstructionRecovery(identity),draft:draft()};writeInstructionRecovery(store,state);expect(await readInstructionRecovery(store,identity)).toEqual(state);
  for(const other of [{...identity,actorId:requestId},{...identity,orderId:requestId},{...identity,environment:'https://TEST.invalid/production/'}])expect(await readInstructionRecovery(store,other)).toEqual(emptyInstructionRecovery(other));
  expect([...store.rows.values()].join('')).not.toMatch(/cookie|token|password|capabilities|roles/);
 });
 it('preserves incomplete raw values and row/attachment identities without applying the save validator',async()=>{
  const store=storage(),raw=draft();raw.document.styleName='  原输入  ';raw.document.fabrics=[{id:requestId,name:' ',part:'',colors:{[actorId]:'  灰 '},remarks:'x'.repeat(5100)}];raw.document.images=[{attachmentId:orderId,kind:'款图',description:'  待补  '}];
  const state={...emptyInstructionRecovery(identity),draft:raw};writeInstructionRecovery(store,state);expect((await readInstructionRecovery(store,identity)).draft).toEqual(raw);expect(store.rows.size).toBe(1);
 });
 it('freezes the normalized original save plus exact versions before sending, separately from the raw editable draft',async()=>{
  const store=storage(),save=await instructionSaveEnvelope(identity,'TEST-save',body,1,100,1),state={...emptyInstructionRecovery(identity),draft:draft(),save};
  expect(JSON.parse(save.body).document.styleName).toBe('TEST原字符串');expect(save.payloadHash).toBe(await instructionPayloadHash(save.body));expect(save.sourceRound).toBe(1);writeInstructionRecovery(store,state);
  expect(await readInstructionRecovery(store,identity)).toEqual(state);expect(instructionEnvelopeRequestBody(save)).toEqual(JSON.parse(save.body));expect(instructionReceiptReadPath(save)).toBe(`orders/${orderId}/instruction/save-receipt?key=TEST-save`);
  expect(state.draft.document.styleName).toBe('  TEST原字符串  ');
 });
 it('keeps PO decision identity/direction/key independent and preserves the exact original two-field hash',async()=>{
  const decision=await instructionDecisionEnvelope(identity,'TEST-decision',requestId,true,1,100);
  expect(decision.payloadHash).toBe(await instructionPayloadHash(JSON.stringify({requestId,approved:true})));expect(instructionEnvelopeRequestBody(decision)).toEqual({approved:true});expect(instructionReceiptReadPath(decision)).toBe(`orders/${orderId}/instruction/date-requests/${requestId}/decision-receipt?key=TEST-decision&approved=true`);
  const receipt={status:'completed',action:'po_customer_decision',orderId,actorId,key:decision.key,requestId,approved:true,payloadHash:decision.payloadHash};
  expect(instructionReceiptMatches(identity,decision,receipt)).toBe(true);
  for(const changed of [{...receipt,approved:false},{...receipt,requestId:actorId},{...receipt,actorId:requestId},{...receipt,key:'OTHER'},{...receipt,payloadHash:'0'.repeat(64)},{...receipt,extra:'no historical body allowed'}])expect(instructionReceiptMatches(identity,decision,changed)).toBe(false);
 });
 it('blocks replacing or dropping unresolved originals, older drafts, corrupt bytes and failed storage',async()=>{
  const store=storage(),save=await instructionSaveEnvelope(identity,'TEST-save',body,1,100,1),state={...emptyInstructionRecovery(identity),draft:draft(3),save};writeInstructionRecovery(store,state);
  expect(()=>writeInstructionRecovery(store,{...state,save:{...save,key:'OTHER'}})).toThrow('不能替换');expect(()=>writeInstructionRecovery(store,{...emptyInstructionRecovery(identity),draft:draft(3)})).toThrow('不能清除');expect(()=>writeInstructionRecovery(store,{...state,draft:draft(2)})).toThrow('较新');
  const key=instructionRecoveryKey(identity);store.rows.set(key,JSON.stringify({...state,save:{...save,body:save.body.replace('TEST原字符串','OTHER')}}));await expect(readInstructionRecovery(store,identity)).rejects.toThrow('校验失败');expect(store.rows.has(key)).toBe(true);
  const denied={...storage(),setItem:()=>{throw Error('TEST storage unavailable');}};expect(()=>writeInstructionRecovery(denied,state)).toThrow('TEST storage unavailable');
 });
 it('clears only the exactly confirmed save while preserving a later draft and independent decision',async()=>{
  const store=storage(),save=await instructionSaveEnvelope(identity,'TEST-save',body,1,100,1),decision=await instructionDecisionEnvelope(identity,'TEST-save',requestId,false,1,100),state={...emptyInstructionRecovery(identity),draft:draft(2),save,decision};writeInstructionRecovery(store,state);
  expect(instructionRecoveryCommandIdentity(save)).not.toBe(instructionRecoveryCommandIdentity(decision));
  const receipt={status:'completed',action:'save',orderId,actorId,key:save.key,payloadHash:save.payloadHash,savedVersion:3,orderVersion:3,sourceRound:1};
  expect(()=>settleInstructionRecovery(store,state,save,{...receipt,savedVersion:4})).toThrow('尚未取得');
  const after=settleInstructionRecovery(store,state,save,receipt);expect(after.save).toBeUndefined();expect(after.draft).toEqual({...state.draft,expectedVersion:3});expect(after.draft!.document).toEqual(state.draft.document);expect(after.decision).toEqual(decision);expect(await readInstructionRecovery(store,identity)).toEqual(after);
 });
 it('does not treat unconfirmed, wrong object, extra historical body or a newer version as proof of the original save',async()=>{
  const save=await instructionSaveEnvelope(identity,'TEST-save',body,1,100,1),receipt={status:'completed',action:'save',orderId,actorId,key:save.key,payloadHash:save.payloadHash,savedVersion:3,orderVersion:3,sourceRound:1};
  for(const changed of [{...receipt,orderId:requestId},{...receipt,sourceRound:2},{...receipt,orderVersion:4},{...receipt,status:'unconfirmed'},{...receipt,document}])expect(instructionReceiptMatches(identity,save,changed)).toBe(false);
 });
 it('matches the submitting sheet source round independently of the optional normalized body field',async()=>{
  const sourceRound=2,save=await instructionSaveEnvelope(identity,'TEST-before-sheet',{...body,sourceRound:7},1,100,sourceRound),store=storage();
  writeInstructionRecovery(store,{...emptyInstructionRecovery(identity),save});expect((await readInstructionRecovery(store,identity)).save).toEqual(save);
  const receipt={status:'completed',action:'save',orderId,actorId,key:save.key,payloadHash:save.payloadHash,savedVersion:3,orderVersion:3,sourceRound};expect(instructionReceiptMatches(identity,save,receipt)).toBe(true);expect(instructionReceiptMatches(identity,save,{...receipt,sourceRound:7})).toBe(false);
 });
 it('persists minimal confirmation before removing the matching pending envelope, with no historical document in the proof',async()=>{
  const store=storage(),save=await instructionSaveEnvelope(identity,'TEST-confirmed',body,1,100,1),state={...emptyInstructionRecovery(identity),draft:draft(),save};writeInstructionRecovery(store,state);
  const receipt={status:'completed',action:'save',orderId,actorId,key:save.key,payloadHash:save.payloadHash,savedVersion:3,orderVersion:3,sourceRound:1};settleInstructionRecovery(store,state,save,receipt);
  const after=await readInstructionRecovery(store,identity);expect(after.save).toBeUndefined();expect(after.draft).toBeUndefined();expect(after.confirmedSave).toMatchObject({receipt,confirmedAt:expect.any(Number)});expect(after.confirmedSave).not.toHaveProperty('document');
  store.rows.set(instructionRecoveryKey(identity),JSON.stringify({...after,confirmedSave:{...after.confirmedSave,receipt:{...receipt,actorId:requestId}}}));await expect(readInstructionRecovery(store,identity)).rejects.toThrow('确认结果身份不符');
 });
});
