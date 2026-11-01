import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {BusinessTime} from '@dx-rework/domain/business-clock';
import {formalCommitmentFacts,initialCustomerDateErrors,minimumInitialCustomerDate,type DigitalOrderInput,type ApprovedShortLeadCalendar} from '@dx-rework/contracts/digital-production';
import {ApplicationError} from '../platform/errors.js';
import {isRootActor} from '../access/business-authority.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {developmentDocumentRow} from './development-round-repository.js';
import {DigitalOrderCreateSchema,initialCustomerOrderInput,initialCustomerOrderIsReady} from '@dx-rework/contracts/digital-production';
import {addCalendarDays} from '@dx-rework/contracts/series-calendar';
type DB=Pick<Pool|PoolClient,'query'>;
const canonicalDocument=(v:unknown):unknown=>Array.isArray(v)?v.map(canonicalDocument):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,value])=>[k,canonicalDocument(value)])):v;
export const shortLeadDocumentHash=(v:unknown)=>createHash('sha256').update(JSON.stringify(canonicalDocument(v))).digest('hex');
export const commitmentHash=(input:DigitalOrderInput)=>createHash('sha256').update(JSON.stringify(formalCommitmentFacts(input))).digest('hex');
export async function shortLeadAvailable(db:DB):Promise<boolean>{return Boolean((await db.query("SELECT to_regclass('digital_short_lead_requests') AS r")).rows[0]?.r);}
export async function approvedShortLeadCalendar(db:DB,sourceId:string,input:DigitalOrderInput,scenarioId:string|null=null):Promise<ApprovedShortLeadCalendar|null>{
 if(!await shortLeadAvailable(db))return null;
 const row=(await db.query(`SELECT r.request_id,r.order_facts,r.commitment_day::text FROM digital_short_lead_requests r
  JOIN digital_short_lead_decisions d USING(request_id) LEFT JOIN digital_short_lead_consumptions c USING(request_id)
  WHERE r.source_id=$1 AND r.facts_hash=$2 AND d.approved AND c.request_id IS NULL AND coalesce(r.business_time->>'scenarioId','')=coalesce($3::text,'') ORDER BY d.recorded_at DESC LIMIT 1`,[sourceId,commitmentHash(input),scenarioId])).rows[0];
 return row?{requestId:row.request_id,facts:formalCommitmentFacts(row.order_facts),commitmentDay:row.commitment_day}:null;
}
export async function shortLeadStaleReason(db:DB,row:{source_id:string|null;source_document_version:number|null;facts_hash:string;source_document_fingerprint:string|null;source_document_status:string|null;commitment_day:Date|string;business_time:{scenarioId?:string|null}}):Promise<string|null>{
 if(!row.source_id)return null;
 if((await db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1',[row.source_id])).rowCount)return '本来源已正式下单，原申请保留历史';
 if((await db.query("SELECT 1 FROM digital_production_resource_lifecycle WHERE resource_kind='source' AND resource_id=$1 AND state<>'active'",[row.source_id])).rowCount)return '开发来源已暂停或取消';
 const sheet=await developmentDocumentRow(db,row.source_id),draft=sheet?.document?.customerOrderDraft;
 const fingerprint=sheet?.document?shortLeadDocumentHash(sheet.document):null;
 const publicationOnly=row.source_document_status==='draft'&&sheet?.status==='published'&&sheet.version===(row.source_document_version??-1)+1&&fingerprint===row.source_document_fingerprint;
 if((sheet?.version??null)!==row.source_document_version&&!publicationOnly||fingerprint!==row.source_document_fingerprint)return '申请后开发资料已变，请按当前资料重新申请';
 if(draft?.stage==='preorder')return '预下单仍为草稿，须先明确转为正式订购草稿';
 let current:DigitalOrderInput|null=null;try{if(draft?.withOrder)current=DigitalOrderCreateSchema.parse(initialCustomerOrderInput(draft.order));}catch{/* Creation allows an incomplete draft. */}
 if(current&&formalCommitmentFacts(current).lines.every(p=>p.customerDate)&&commitmentHash(current)!==row.facts_hash){
  const day=typeof row.commitment_day==='string'?row.commitment_day.slice(0,10):row.commitment_day.toISOString().slice(0,10);
  const normalReady=draft?.withOrder&&initialCustomerOrderIsReady(draft.order,{serverToday:day,minimumInitialCustomerDate:addCalendarDays(day,30)});
  const priorApproval=(await db.query(`SELECT 1 FROM digital_short_lead_requests r JOIN digital_short_lead_decisions d USING(request_id) LEFT JOIN digital_short_lead_consumptions c USING(request_id)
   WHERE r.source_id=$1 AND r.facts_hash=$2 AND (r.source_document_version=$3 OR r.source_document_status='draft' AND r.source_document_version=$3-1 AND r.source_document_fingerprint=$5) AND d.approved AND c.request_id IS NULL AND coalesce(r.business_time->>'scenarioId','')=coalesce($4::text,'')`,[row.source_id,commitmentHash(current),sheet?.version,row.business_time.scenarioId??null,fingerprint])).rowCount;
  if(sheet?.status!=='published'||normalReady||priorApproval)return '申请与已保存的完整订购资料不一致；原已确认依据不能覆盖，请返回原开发档案核对';
 }
 return null;
}
export async function validateInitialLeadTime(db:DB,actor:TrustedActorContext,sourceId:string|null,input:DigitalOrderInput,time:BusinessTime){
 const now=new Date(time.now);
 const facts=formalCommitmentFacts(input);
 if(facts.lines.some(p=>!p.customerDate))throw new ApplicationError('VALIDATION_ERROR','请填写每个PO的客户约定出货日期',400);
 const errors=initialCustomerDateErrors(input.lines,minimumInitialCustomerDate(now));
 if(!input.shortLeadApprovalId){if(errors.length)throw new ApplicationError('SHORT_LEAD_APPROVAL_REQUIRED','不足30自然日的正式订单须先取得老板或Root特批；开发草稿仍可保存',409);return null;}
 const reject=():never=>{throw new ApplicationError('SHORT_LEAD_APPROVAL_STALE','特批未通过、已使用或不对应本单当前资料，请刷新原申请',409);};
 if(!await shortLeadAvailable(db))return reject();
 const row=(await db.query(`SELECT r.*,r.commitment_day::text AS commitment_day,r.commitment_day::text AS day,d.approved,c.production_order_id AS consumed_order_id
  FROM digital_short_lead_requests r JOIN digital_short_lead_decisions d USING(request_id)
  LEFT JOIN digital_short_lead_consumptions c USING(request_id) WHERE r.request_id=$1 FOR UPDATE OF r`,[input.shortLeadApprovalId])).rows[0];
 if(!row||!row.approved||row.consumed_order_id||row.source_id!==sourceId||(row.business_time?.scenarioId??null)!==time.scenarioId||row.facts_hash!==commitmentHash(input)
   ||!sourceId&&row.requested_by!==actor.actorId&&!isRootActor(actor))return reject();
 if(await shortLeadStaleReason(db,row))return reject();
 return {requestId:row.request_id as string,factsHash:row.facts_hash as string,commitmentDay:row.day as string};
}
export async function consumeShortLead(db:DB,actor:TrustedActorContext,orderId:string,approval:Awaited<ReturnType<typeof validateInitialLeadTime>>,time:unknown,creationEventId:string){
 if(!approval)return;
 await db.query(`INSERT INTO digital_short_lead_consumptions(production_order_id,request_id,facts_hash,commitment_day,consumed_by,business_time,creation_event_id)
  VALUES($1,$2,$3,$4,$5,$6,$7)`,[orderId,approval.requestId,approval.factsHash,approval.commitmentDay,actor.actorId,JSON.stringify(time),creationEventId]);
}
