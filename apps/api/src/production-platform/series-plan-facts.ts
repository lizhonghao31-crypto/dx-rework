import {commentTimeColumns} from './development-comment-time.js';
import {preparationAvailable,preparationContext,preparationMaterialHistory,currentPreparationMaterials} from './preparation-material-repository.js';
import type {PoolClient} from 'pg';
import type {SeriesObservedFact,SeriesSourceEvent} from '@dx-rework/contracts/digital-series-plan';
import {SeriesSourceEventSchema} from '@dx-rework/contracts/digital-series-plan';
import {developmentDocumentRow} from './development-round-repository.js';
import {effectiveTechnicalEvidence} from './development-technical-repository.js';
import {bulkFabricFacts} from './bulk-fabric-facts.js';
import {factoryBatchLedger,type FactoryScope} from './factory-batch-ledger.js';
type DB=Pick<PoolClient,'query'>;
const iso=(v:Date|string|null|undefined)=>v?new Date(v).toISOString():null;
/** Native records remain authoritative. recorded_at is never substituted for an unknown actual time. */
export async function readSeriesPlanFacts(db:DB,orderId:string,sourceId:string|null,customerCode:string,sourceRound?:number,includePreparationFacts=false){
 const facts:SeriesObservedFact[]=[],revisions:Record<string,unknown>={};
 const events=(await db.query(`SELECT DISTINCT ON(node_key,scope_ref) *,occurred_date::text AS occurred_date
  FROM digital_series_source_events WHERE production_order_id=$1 ORDER BY node_key,scope_ref,source_version DESC`,[orderId])).rows;
 revisions.events=events.map(e=>[e.event_id,e.source_version,e.voided,e.business_completed]);
 const instrumented=new Set(events.map(e=>`${e.node_key}:${e.scope_ref}`));
 const nativeMaterials=await preparationAvailable(db)?currentPreparationMaterials(await preparationMaterialHistory(db,await preparationContext(db,{kind:'order',id:orderId})),orderId):[];
 revisions.materialValidity=nativeMaterials.map(f=>[f.recordId,f.version,f.valid]);
 for(const e of events)if(!e.voided){const native=nativeMaterials.find(f=>f.recordId===e.source_record_id&&f.version===e.source_version);facts.push({key:e.node_key,scopeRef:e.scope_ref,sourceDomain:e.source_domain,sourceRecordId:e.source_record_id,sourceVersion:e.source_version,
  completed:e.business_completed!==false&&(!native||native.valid&&(native.kind!=='material_investment'||native.state==='ready')),started:true,occurredAt:iso(e.occurred_at),occurredDate:e.occurred_date?String(e.occurred_date).slice(0,10):null,precision:e.precision,reason:native&&!native.valid?native.invalidReasons.join('；'):e.reason});}
 const fabric=await bulkFabricFacts(db,orderId);revisions.fabric=fabric;
 if(fabric.report&&!instrumented.has('fabric_receipt:whole')){const at=iso(fabric.report.arrivedAt);facts.push({key:'fabric_receipt',scopeRef:'whole',sourceDomain:'bulk-preparation',sourceRecordId:fabric.report.reportId,sourceVersion:1,
  completed:Boolean(at),started:Boolean(at),occurredAt:at,occurredDate:null,precision:at?'instant':'unknown',reason:at?'来自原验布到仓记录':'原验布记录未提供可信到仓时间'});}
 let document:Awaited<ReturnType<typeof developmentDocumentRow>>|null=null;
 if(sourceId){
  document=await developmentDocumentRow(db,sourceId,sourceRound);revisions.development=document?{version:document.version,round:document.round_number,document:document.document}:null;
  if(document){const evidence=await effectiveTechnicalEvidence(db,sourceId,document.round_number,'整款',customerCode);revisions.technical=evidence;
   const timeSql=await commentTimeColumns(db);
   const comments=(await db.query(`SELECT DISTINCT ON(c.scope_ref) c.comment_id,c.scope_ref,c.version,c.decision,${timeSql.columns},c.customer_code FROM digital_development_final_comments c ${timeSql.join}
    WHERE c.source_id=$1 AND c.round_number=$2 AND c.is_final ORDER BY c.scope_ref,c.version DESC`,[sourceId,document.round_number])).rows;
   revisions.finalComments=comments.map(c=>[c.comment_id,c.scope_ref,c.version,c.decision,c.customer_code,c.time_evidence_id,c.occurred_date]);
   for(const c of comments){if(instrumented.has(`client_sample_approval:${c.scope_ref==='整款'?'whole':c.scope_ref}`))continue;const ok=c.decision==='approved'&&c.customer_code===customerCode,at=iso(c.occurred_at),date=c.occurred_date??null;
    facts.push({key:'client_sample_approval',scopeRef:c.scope_ref==='整款'?'whole':c.scope_ref,sourceDomain:'development',sourceRecordId:c.comment_id,sourceVersion:c.version,
     completed:ok,started:ok,occurredAt:at,occurredDate:date,precision:at?'instant':date?'date':'unknown',reason:ok?(at||date?null:'客户已批复，但实际批复时间未知；不使用录入时间代替'):'最新最终评语尚未批准本客户成果'});
   }
  }
 }
 const route=(await db.query('SELECT preparation_id,workflow_version,secondary_craft FROM digital_factory_routes WHERE production_order_id=$1',[orderId])).rows[0];
 const movements=route?(await db.query('SELECT * FROM digital_factory_facts WHERE preparation_id=$1 ORDER BY sequence',[route.preparation_id])).rows:[],sends=movements.filter(f=>f.kind==='仓库实际发厂');
 revisions.dispatch={route:route??null,facts:movements.map(f=>[f.fact_id,f.sequence,f.payload,iso(f.occurred_at)])};
 let allDispatched=false,completionReason='已发部分批次；不将部分发出推断为整单发齐';
 if(sends.length&&route?.workflow_version===2){
  const quantities=(await db.query(`SELECT po.line_id AS "lineId",r.actual_cut_count::int AS quantity FROM digital_production_po_lines po
   LEFT JOIN digital_production_child_lines l ON l.module='cutting' AND l.line_id=po.line_id LEFT JOIN current_cutting_records r ON r.cutting_order_id=l.child_id
   WHERE po.production_order_id=$1 ORDER BY po.position`,[orderId])).rows as Array<{lineId:string;quantity:number|null}>;
  const known=quantities.length>0&&quantities.every(q=>q.quantity!==null&&Number.isSafeInteger(q.quantity)&&q.quantity>0);
  // Completion uses the original quantity ledger. This does not infer QC approval or permission to dispatch.
  const ledger=factoryBatchLedger(quantities.filter((q):q is FactoryScope=>q.quantity!==null&&Number.isSafeInteger(q.quantity)&&q.quantity>0),movements,[],route.secondary_craft==='无');
  revisions.dispatchQuantities=quantities;allDispatched=known&&ledger.complete&&!ledger.quantityConflict;
  completionReason=!known?'原实裁数量范围缺证，不推断整单发齐':ledger.quantityConflict?'已发数量超过当前实裁，保留原事实并待原数量差异处理':allDispatched?'原批次数量账本确认全部发齐':completionReason;
 }else if(sends.length){allDispatched=sends.some(f=>!Array.isArray(f.payload?.lines));if(allDispatched)completionReason='原整款仓库发厂记录';}
 for(const f of sends){const at=iso(f.occurred_at);facts.push({key:'processing_dispatch',scopeRef:`batch:${f.fact_id}`,sourceDomain:'factory-flow',sourceRecordId:f.fact_id,sourceVersion:f.sequence,
  completed:true,started:true,occurredAt:at,occurredDate:null,precision:at?'instant':'unknown',reason:'原仓库实际发厂批次；不代表其他批次已发齐'});}
 if(sends.length&&!instrumented.has('processing_dispatch:whole')){const last=sends.at(-1)!,at=allDispatched&&sends.every(f=>f.occurred_at)?new Date(Math.max(...sends.map(f=>new Date(f.occurred_at).getTime()))).toISOString():null;
  facts.push({key:'processing_dispatch',scopeRef:'whole',sourceDomain:'factory-flow',sourceRecordId:last.fact_id,sourceVersion:last.sequence,
  completed:allDispatched,started:true,occurredAt:at,occurredDate:null,precision:at?'instant':'unknown',reason:allDispatched&&!at?`${completionReason}；部分实际发出时间未知，不补造完成时刻`:completionReason});}
 return {facts,...(includePreparationFacts?{preparationFacts:nativeMaterials}:{}),revisions,document,fabric};
}
/** PR05 native producers call inside their authorized transaction; deliberately not an HTTP command. */
export async function appendSeriesSourceEvent(db:DB,event:SeriesSourceEvent,actorId:string,businessTime:unknown){
 const e=SeriesSourceEventSchema.parse(event);
 await db.query(`INSERT INTO digital_series_source_events(event_id,production_order_id,node_key,scope_ref,source_domain,source_record_id,source_version,occurred_at,occurred_date,precision,supersedes_event_id,voided,reason,created_by,business_time,business_completed)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,[e.eventId,e.orderId,e.key,e.scopeRef,e.sourceDomain,e.sourceRecordId,e.sourceVersion,e.occurredAt,e.occurredDate,e.precision,e.supersedesEventId,e.voided,e.reason,actorId,JSON.stringify(businessTime),e.businessCompleted??true]);
}
