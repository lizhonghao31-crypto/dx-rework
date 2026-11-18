import {z} from 'zod';
import {SaveInstructionSchema,InstructionReceiptKeySchema,InstructionSaveReceiptSchema,PoCustomerDecisionReceiptSchema,type InstructionDocument} from '@dx-rework/contracts/production-instruction';

/** Same-tab recovery only. Callers must freshly verify the server actor and
 * current object-read access BEFORE reading this actor/object/environment key.
 * Neither storage nor this envelope grants permission or triggers a write. */
export type InstructionRecoveryIdentity={environment:string;actorId:string;orderId:string};
const identitySchema=z.object({environment:z.string().min(1).max(1000),actorId:z.uuid(),orderId:z.uuid()}).strict();
const generation=z.number().int().nonnegative(),hash=z.string().regex(/^[a-f0-9]{64}$/);
const envelopeBase={key:InstructionReceiptKeySchema,payloadHash:hash,body:z.string().min(1),generation,startedAt:z.number().finite().nonnegative()};
const saveEnvelopeSchema=z.object({...envelopeBase,kind:z.literal('save'),method:z.literal('PUT'),path:z.string(),expectedVersion:generation,orderVersion:z.number().int().positive(),sourceRound:z.number().int().positive().nullable()}).strict();
const decisionEnvelopeSchema=z.object({...envelopeBase,kind:z.literal('decision'),method:z.literal('POST'),path:z.string(),requestId:z.uuid(),approved:z.boolean()}).strict();
export type InstructionSaveEnvelope=z.infer<typeof saveEnvelopeSchema>;
export type InstructionDecisionEnvelope=z.infer<typeof decisionEnvelopeSchema>;
export type InstructionRecoveryEnvelope=InstructionSaveEnvelope|InstructionDecisionEnvelope;
// Keys belong to a fixed command namespace, not to the entire page. Two
// independent originals may legally have the same key in different namespaces.
export const instructionRecoveryCommandIdentity=(envelope:InstructionRecoveryEnvelope)=>JSON.stringify([envelope.kind,envelope.path,envelope.key,envelope.payloadHash]);
// A local draft deliberately does NOT pass through SaveInstructionSchema:
// incomplete strings/rows are user input, not a valid outgoing command yet.
const rawText=z.string(),rawRow=z.object({id:rawText});
const rawDocument=z.object({styleName:rawText,category:rawText,season:rawText,fabricType:rawText,composition:rawText,date:rawText.nullable(),process:rawText,secondaryCraft:rawText,remarks:rawText,patternMaker:rawText,preshrink:rawText,shipSample:rawText,sewingRequirements:rawText,comments:rawText,
 fabrics:z.array(rawRow.extend({name:rawText,part:rawText,colors:z.record(z.string(),rawText),remarks:rawText}).strict()),
 accessories:z.array(rawRow.extend({group:rawText,garmentColors:rawText,materialColor:rawText,name:rawText,category:rawText,part:rawText,specification:rawText,consumption:rawText,remarks:rawText}).strict()),
 images:z.array(z.object({attachmentId:rawText,kind:rawText,description:rawText}).strict()),unit:rawText,sizes:z.array(rawText),
 measurements:z.array(rawRow.extend({name:rawText,tolerance:rawText,method:rawText,values:z.array(rawText)}).strict()),craftSteps:z.array(z.record(z.string(),z.unknown())).optional(),
}).strict();
const draftSchema=z.object({document:rawDocument,generation,expectedVersion:generation,orderVersion:z.number().int().positive(),sourceRound:z.number().int().positive().nullable()}).strict();
const storedSchema=z.object({version:z.literal(1),identity:identitySchema,draft:draftSchema.optional(),save:saveEnvelopeSchema.optional(),decision:decisionEnvelopeSchema.optional(),
 confirmedSave:z.object({receipt:InstructionSaveReceiptSchema.options[1],confirmedAt:z.number().finite().nonnegative()}).strict().optional(),
 confirmedDecision:z.object({receipt:PoCustomerDecisionReceiptSchema.options[1],confirmedAt:z.number().finite().nonnegative()}).strict().optional(),
}).strict();
export type InstructionRecoveryState=Omit<z.infer<typeof storedSchema>,'draft'>&{draft?:{document:InstructionDocument;generation:number;expectedVersion:number;orderVersion:number;sourceRound:number|null}};
type RecoveryStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const maximumBytes=4*1024*1024;
const checkedIdentity=(identity:InstructionRecoveryIdentity)=>identitySchema.parse(identity);
export const instructionRecoveryKey=(identity:InstructionRecoveryIdentity)=>'dx:instruction-recovery:v1:'+JSON.stringify(checkedIdentity(identity));
export const instructionPayloadHash=async(body:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body))),byte=>byte.toString(16).padStart(2,'0')).join('');
export const emptyInstructionRecovery=(identity:InstructionRecoveryIdentity):InstructionRecoveryState=>({version:1,identity:checkedIdentity(identity)});
export async function instructionSaveEnvelope(identity:InstructionRecoveryIdentity,key:string,body:unknown,editGeneration:number,startedAt:number,beforeSourceRound:number|null):Promise<InstructionSaveEnvelope>{
 checkedIdentity(identity);const parsed=SaveInstructionSchema.parse(body),normalized=JSON.stringify(parsed);
 return saveEnvelopeSchema.parse({kind:'save',key,body:normalized,payloadHash:await instructionPayloadHash(normalized),generation:editGeneration,startedAt,method:'PUT',path:`orders/${identity.orderId}/instruction`,expectedVersion:parsed.expectedVersion,orderVersion:parsed.orderVersion,sourceRound:beforeSourceRound});
}
export async function instructionDecisionEnvelope(identity:InstructionRecoveryIdentity,key:string,requestId:string,approved:boolean,editGeneration:number,startedAt:number):Promise<InstructionDecisionEnvelope>{
 checkedIdentity(identity);z.uuid().parse(requestId);z.boolean().parse(approved);
 // This exact two-field order matches the original server command hash.
 const body=JSON.stringify({requestId,approved});
 return decisionEnvelopeSchema.parse({kind:'decision',key,body,payloadHash:await instructionPayloadHash(body),generation:editGeneration,startedAt,method:'POST',path:`orders/${identity.orderId}/instruction/date-requests/${requestId}/decision`,requestId,approved});
}
async function verifyEnvelope(identity:InstructionRecoveryIdentity,envelope:InstructionRecoveryEnvelope){
 if(await instructionPayloadHash(envelope.body)!==envelope.payloadHash)throw Error('原提交本地封套校验失败；保留记录，不能重发');
 const parsed:unknown=JSON.parse(envelope.body);
 if(envelope.kind==='save'){
  const body=SaveInstructionSchema.parse(parsed);
  if(JSON.stringify(body)!==envelope.body||envelope.path!==`orders/${identity.orderId}/instruction`||body.expectedVersion!==envelope.expectedVersion||body.orderVersion!==envelope.orderVersion)throw Error('原制单提交身份或版本不一致；保留记录，不能重发');
 }else{
  const body=z.object({requestId:z.uuid(),approved:z.boolean()}).strict().parse(parsed);
  if(JSON.stringify(body)!==envelope.body||body.requestId!==envelope.requestId||body.approved!==envelope.approved||envelope.path!==`orders/${identity.orderId}/instruction/date-requests/${envelope.requestId}/decision`)throw Error('原交期决定身份或方向不一致；保留记录，不能重发');
 }
}
export async function readInstructionRecovery(storage:RecoveryStorage,identity:InstructionRecoveryIdentity):Promise<InstructionRecoveryState>{
 const raw=storage.getItem(instructionRecoveryKey(identity));if(raw===null)return emptyInstructionRecovery(identity);
 if(raw.length>maximumBytes)throw Error('原制单恢复资料过大；保留记录，不能自动提交');
 const state=storedSchema.parse(JSON.parse(raw));
 if(JSON.stringify(state.identity)!==JSON.stringify(checkedIdentity(identity)))throw Error('原制单恢复身份不匹配；保留记录，不能自动提交');
 if(state.save)await verifyEnvelope(identity,state.save);if(state.decision)await verifyEnvelope(identity,state.decision);
 for(const proof of [state.confirmedSave?.receipt,state.confirmedDecision?.receipt])if(proof&&(proof.actorId!==identity.actorId||proof.orderId!==identity.orderId))throw Error('原确认结果身份不符，恢复记录已保留');
 return state as InstructionRecoveryState;
}
/** Store the complete raw draft and the two independent immutable originals.
 * A caller must retain the other unresolved command and any newer edit. */
function persist(storage:RecoveryStorage,state:InstructionRecoveryState,confirmed?:InstructionRecoveryEnvelope){
 const key=instructionRecoveryKey(state.identity),prior=storage.getItem(key),checked=storedSchema.parse(state);
 if(prior!==null){
  const original=storedSchema.parse(JSON.parse(prior));
  for(const kind of ['save','decision'] as const){
   const before=original[kind],next=checked[kind];
   if(before&&next&&JSON.stringify(before)!==JSON.stringify(next))throw Error('原提交仍待核对，不能替换为另一条命令');
   if(before&&!next&&JSON.stringify(before)!==JSON.stringify(confirmed))throw Error('原提交尚未核实，不能清除原标识');
  }
  if(original.draft&&checked.draft&&checked.draft.generation<original.draft.generation)throw Error('较新制单草稿已保留，不能用旧回执覆盖');
 }
 const raw=JSON.stringify(checked);if(raw.length>maximumBytes)throw Error('本页恢复资料超出保存限额，请保留输入，尚未提交');
 storage.setItem(key,raw);if(storage.getItem(key)!==raw)throw Error('本页恢复资料未能确认保存，尚未提交');
}
export function writeInstructionRecovery(storage:RecoveryStorage,state:InstructionRecoveryState){persist(storage,state);}
export function instructionReceiptMatches(identity:InstructionRecoveryIdentity,envelope:InstructionRecoveryEnvelope,value:unknown){
 const parsed=envelope.kind==='save'?InstructionSaveReceiptSchema.safeParse(value):PoCustomerDecisionReceiptSchema.safeParse(value);
 if(!parsed.success)return false;const receipt=parsed.data;
 if(receipt.status!=='completed'||receipt.actorId!==identity.actorId||receipt.orderId!==identity.orderId||receipt.key!==envelope.key||receipt.payloadHash!==envelope.payloadHash)return false;
 return envelope.kind==='save'?receipt.action==='save'&&receipt.savedVersion===envelope.expectedVersion+1&&receipt.orderVersion===envelope.orderVersion&&receipt.sourceRound===envelope.sourceRound:receipt.action==='po_customer_decision'&&receipt.requestId===envelope.requestId&&receipt.approved===envelope.approved;
}
export function instructionReceiptReadPath(envelope:InstructionRecoveryEnvelope){
 return envelope.kind==='save'?`${envelope.path}/save-receipt?${new URLSearchParams({key:envelope.key})}`:`${envelope.path}-receipt?${new URLSearchParams({key:envelope.key,approved:String(envelope.approved)})}`;
}
/** The decision hash includes the request from its URL; the original POST body
 * remains only {approved}. No recovery helper dispatches either method. */
export const instructionEnvelopeRequestBody=(envelope:InstructionRecoveryEnvelope):unknown=>envelope.kind==='save'?JSON.parse(envelope.body):{approved:envelope.approved};
export function settleInstructionRecovery(storage:RecoveryStorage,state:InstructionRecoveryState,envelope:InstructionRecoveryEnvelope,receipt:unknown){
 if(!instructionReceiptMatches(state.identity,envelope,receipt))throw Error('尚未取得匹配的原命令回执，原输入与标识保留');
 const key=envelope.kind==='save'?'save':'decision';if(JSON.stringify(state[key])!==JSON.stringify(envelope))throw Error('当前待核命令已变化，保留现有恢复状态');
 const next={...state};delete next[key];
 if(envelope.kind==='save')next.confirmedSave={receipt:InstructionSaveReceiptSchema.options[1].parse(receipt),confirmedAt:Date.now()};
 else next.confirmedDecision={receipt:PoCustomerDecisionReceiptSchema.options[1].parse(receipt),confirmedAt:Date.now()};
 // The caller may refresh the confirmed original, but must not replace a later
 // draft or remove another independent uncertain command with this receipt.
 if(envelope.kind==='save'&&next.draft?.generation===envelope.generation)delete next.draft;
 else if(envelope.kind==='save'&&next.draft&&next.draft.expectedVersion===envelope.expectedVersion&&next.draft.orderVersion===envelope.orderVersion&&next.draft.sourceRound===envelope.sourceRound){
  const proof=InstructionSaveReceiptSchema.parse(receipt);if(proof.status==='completed')next.draft={...next.draft,expectedVersion:proof.savedVersion};
 }
 persist(storage,next,envelope);return next;
}
/** Only for a definitely refused FIRST write, never a read/recovery response.
 * The original caller classifies that response before invoking this function. */
export function rejectOriginalInstructionRecovery(storage:RecoveryStorage,state:InstructionRecoveryState,envelope:InstructionRecoveryEnvelope){
 const kind=envelope.kind==='save'?'save':'decision';if(JSON.stringify(state[kind])!==JSON.stringify(envelope))throw Error('原拒绝回执与当前命令不符，保留恢复状态');
 const next={...state};delete next[kind];persist(storage,next,envelope);return next;
}
