import {useRef,useState} from 'react';
import type {InstructionDocument,InstructionSheet} from '@dx-rework/contracts/production-instruction';
import type {DigitalOrder} from '@dx-rework/contracts/digital-production';
import type {DigitalAccessOptions} from './digital-production-access-panel.js';
import {digitalRequest} from './digital-production-api.js';
import {emptyInstructionRecovery,instructionDecisionEnvelope,instructionReceiptMatches,instructionReceiptReadPath,instructionRecoveryCommandIdentity,instructionSaveEnvelope,readInstructionRecovery,rejectOriginalInstructionRecovery,settleInstructionRecovery,writeInstructionRecovery,type InstructionRecoveryEnvelope,type InstructionRecoveryState} from './instruction-recovery-state.js';

/** Narrow controller for the original instruction form. Persistence contains
 * no authority; fresh access/options plus the original sheet read gate restore.
 * Receipt recovery is GET only. No effect/timer dispatches a business command. */
export function useInstructionRecovery(orderId:string){
 const state=useRef<InstructionRecoveryState|null>(null),sequence=useRef(0),known=useRef(new Set<string>()),needsSheet=useRef(false);
 const gate=useRef({ready:false,blocked:false,restored:false,conflict:false});
 const [ready,setReadyView]=useState(false),[blocked,setBlockedView]=useState(false),[restored,setRestoredView]=useState(false),[conflict,setConflictView]=useState(false),[message,setMessage]=useState(''),[,render]=useState(0);
 const setReady=(value:boolean)=>{gate.current.ready=value;setReadyView(value);},setBlocked=(value:boolean)=>{gate.current.blocked=value;setBlockedView(value);},setRestored=(value:boolean)=>{gate.current.restored=value;setRestoredView(value);},setConflict=(value:boolean)=>{gate.current.conflict=value;setConflictView(value);};
 const publish=()=>render(value=>value+1),identity=()=>{if(!state.current)throw Error('身份和原对象尚未核实，未提交');return state.current.identity;};
 const confirmationNotice=(saved:InstructionRecoveryState)=>[saved.confirmedSave?'原制单保存已确认成功。':'',saved.confirmedDecision?'原客户交期决定已确认成功。':''].filter(Boolean).join(' ');
 const mask=()=>{sequence.current++;state.current=null;known.current.clear();needsSheet.current=false;setReady(false);setBlocked(false);setRestored(false);setConflict(false);setMessage('');};
 const store=(next:InstructionRecoveryState)=>{
  state.current=next;publish();
  try{writeInstructionRecovery(window.sessionStorage,next);}catch(error){needsSheet.current=false;setBlocked(true);setMessage(error instanceof Error?error.message:'本页恢复资料未能保存，尚未提交');throw error;}
 };
 const load=async(sheet:InstructionSheet,enabled:boolean)=>{
  const current=sequence.current;
  if(!enabled){setReady(true);return {document:sheet.document,dirty:false,pending:false,generation:0,receipt:''};}
  const access=await digitalRequest<DigitalAccessOptions>('access/options');if(current!==sequence.current)throw Error('读取身份已变化，请重新读取');
  const scope={actorId:access.actorId,orderId,environment:window.location.origin+import.meta.env.BASE_URL};
  state.current=emptyInstructionRecovery(scope);
  try{
   const saved=await readInstructionRecovery(window.sessionStorage,scope);if(current!==sequence.current)throw Error('读取身份已变化，请重新读取');state.current=saved;
   const draft=saved.draft,changed=Boolean(draft&&(draft.expectedVersion!==sheet.version||draft.orderVersion!==sheet.order.version||draft.sourceRound!==sheet.sourceRound));
   setConflict(changed);setRestored(Boolean(draft));setReady(true);setBlocked(false);setMessage(changed?'本页恢复稿的原版本或开发轮次已变化；请对照最新原资料，恢复稿尚未提交。':draft?'已恢复本页未提交修改；不会自动保存，请继续编辑或明确保存。':'');publish();
   return {document:draft?.document??(saved.save?JSON.parse(saved.save.body).document as InstructionDocument:sheet.document),dirty:Boolean(draft||saved.save),pending:Boolean(saved.save||saved.decision),generation:Math.max(draft?.generation??0,saved.save?.generation??0,saved.decision?.generation??0),receipt:confirmationNotice(saved)};
  }catch(error){
   if(current!==sequence.current)throw error;
   setReady(true);setBlocked(true);setMessage(error instanceof Error?error.message:'本页恢复资料尚未核实，不能提交');
   return {document:sheet.document,dirty:false,pending:false,generation:0,receipt:''};
  }
 };
 const loadUnavailable=async()=>{
  const stamp=sequence.current,access=await digitalRequest<DigitalAccessOptions>('access/options'),order=await digitalRequest<DigitalOrder>(`orders/${orderId}`);
  if(stamp!==sequence.current||order.productionOrderId!==orderId)throw Error('当前身份或母单尚未核实，未读取恢复内容');
  const owner={actorId:access.actorId,orderId,environment:window.location.origin+import.meta.env.BASE_URL},saved=await readInstructionRecovery(window.sessionStorage,owner);if(stamp!==sequence.current)throw Error('当前身份已变化，未展示原恢复内容');
  state.current=saved;needsSheet.current=true;setReady(true);setBlocked(true);setRestored(Boolean(saved.draft));setMessage('最新制单尚未读取；原输入及命令标识保留，仅可只读核对原结果。');publish();
  return {dirty:Boolean(saved.draft||saved.save),pending:Boolean(saved.save||saved.decision),receipt:confirmationNotice(saved)};
 };
 const edit=(document:InstructionDocument,sheet:InstructionSheet,generation:number)=>{
  if(!ready||!state.current)throw Error('恢复身份尚未核实，修改保留在当前页面');
  const previous=state.current.draft;
  store({...state.current,draft:{document,generation,expectedVersion:previous?.expectedVersion??sheet.version,orderVersion:previous?.orderVersion??sheet.order.version,sourceRound:previous?previous.sourceRound:sheet.sourceRound}});
  if(!conflict){setRestored(false);if(!blocked)setMessage('');}
 };
 const begin=async(path:string,method:string,body:unknown,generation:number,key:string,before:InstructionSheet,manualSave=false)=>{
  const currentGate=gate.current;
  if(!currentGate.ready||currentGate.blocked||currentGate.conflict)throw Error(message||'本页原资料尚未核实，未提交');
  if(currentGate.restored&&!(manualSave&&method==='PUT'&&path===''))throw Error('本页恢复稿未自动提交，请明确保存或继续编辑');
  const original=state.current;if(!original)throw Error('本页恢复资料尚未初始化，未提交');
  if(original.identity.orderId!==orderId)throw Error('当前母单已变化，原命令未发送');
  if(original.save||original.decision)throw Error('原提交尚未核实，不能另提');
  const decision=method==='POST'?/^\/date-requests\/([0-9a-f-]{36})\/decision$/i.exec(path):null;
  if(decision&&typeof (body as {approved?:unknown})?.approved!=='boolean')throw Error('原交期决定方向无效，未提交');
  const envelope=method==='PUT'&&path===''?await instructionSaveEnvelope(identity(),key,body,generation,Date.now(),before.sourceRound):decision?await instructionDecisionEnvelope(identity(),key,decision[1]!,((body as {approved:boolean}).approved),generation,Date.now()):null;
  if(envelope){
   if(state.current?.identity!==original.identity)throw Error('本页身份已变化，未提交');
   store({...state.current,[envelope.kind==='save'?'save':'decision']:envelope});
  }
  return envelope;
 };
 const settle=async(envelope:InstructionRecoveryEnvelope,receipt:unknown)=>{
  const owner=identity(),stamp=sequence.current;
  if(!instructionReceiptMatches(owner,envelope,receipt))throw Error('原提交回执尚未匹配，原输入和标识保留');
  // Confirm before an optional latest-sheet read. A later read failure cannot
  // turn this known result into an unknown write or authorize another POST.
  known.current.add(instructionRecoveryCommandIdentity(envelope));publish();
  try{
   const latest=await readInstructionRecovery(window.sessionStorage,owner);if(stamp!==sequence.current)return;
   state.current=settleInstructionRecovery(window.sessionStorage,latest,envelope,receipt);if(!state.current.draft&&!state.current.save&&!state.current.decision)setMessage('');publish();
  }catch(error){needsSheet.current=false;setBlocked(true);setMessage('原提交已确认成功；本页恢复记录尚未确认保存，请保留页面。'+(error instanceof Error?error.message:''));}
 };
 const confirmed=async(envelope:InstructionRecoveryEnvelope,sheet:InstructionSheet)=>{
  const own={orderId,actorId:identity().actorId,key:envelope.key,payloadHash:envelope.payloadHash,status:'completed'};
  await settle(envelope,envelope.kind==='save'?{...own,action:'save',savedVersion:sheet.version,orderVersion:sheet.order.version,sourceRound:sheet.sourceRound}:{...own,action:'po_customer_decision',requestId:envelope.requestId,approved:envelope.approved});
 };
 const rejected=(envelope:InstructionRecoveryEnvelope)=>{
  if(!state.current)return;try{state.current=rejectOriginalInstructionRecovery(window.sessionStorage,state.current,envelope);publish();}catch(error){setBlocked(true);setMessage(error instanceof Error?error.message:'原拒绝结果已取得，本页恢复标识尚未更新');}
 };
 const check=async(kind:'save'|'decision')=>{
  const original=state.current,envelope=original?.[kind],stamp=sequence.current;if(!original||!envelope)throw Error('本页没有保留该原提交标识；不能重发');
  const access=await digitalRequest<DigitalAccessOptions>('access/options');if(access.actorId!==original.identity.actorId||stamp!==sequence.current)throw Error('当前身份与原提交不符，不能读取原回执');
  const receipt=await digitalRequest<unknown>(instructionReceiptReadPath(envelope));if(stamp!==sequence.current)return false;
  if(!instructionReceiptMatches(original.identity,envelope,receipt))throw Error('尚未取得匹配的原命令回执，原输入与标识保留；请勿另提');
  await settle(envelope,receipt);return true;
 };
 const discardDraft=()=>{if(state.current){const next={...state.current};delete next.draft;store(next);}setRestored(false);setConflict(false);setMessage('');};
 const clearSavedDraft=(generation:number)=>{if(state.current?.draft?.generation===generation){const next={...state.current};delete next.draft;store(next);}};
 const unresolved=(kind:'save'|'decision')=>Boolean(state.current?.[kind]&&!known.current.has(instructionRecoveryCommandIdentity(state.current[kind]!)));
 const observe=(sheet:InstructionSheet)=>{const draft=state.current?.draft,changed=Boolean(draft&&(draft.expectedVersion!==sheet.version||draft.orderVersion!==sheet.order.version||draft.sourceRound!==sheet.sourceRound)),readable=!blocked||needsSheet.current;if(needsSheet.current){needsSheet.current=false;setBlocked(false);}setConflict(changed);if(changed)setMessage('恢复稿对应的原资料已变化，请先核对；未自动保存。');else if(readable)setMessage(draft&&restored?'较新恢复稿仍保留，未自动保存。':'');};
 return {mask,load,loadUnavailable,edit,begin,confirmed,rejected,check,discardDraft,clearSavedDraft,observe,ready,blocked,restored,conflict,message,get savePending(){return unresolved('save');},get decisionPending(){return unresolved('decision');},get hasDraft(){return Boolean(state.current?.draft);},get hasUnresolved(){return unresolved('save')||unresolved('decision');}};
}
