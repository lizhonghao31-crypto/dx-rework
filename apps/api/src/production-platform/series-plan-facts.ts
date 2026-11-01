import type {PoolClient} from 'pg';
import type {SeriesObservedFact,SeriesSourceEvent} from '@dx-rework/contracts/digital-series-plan';
import {SeriesSourceEventSchema} from '@dx-rework/contracts/digital-series-plan';
import {developmentDocumentRow} from './development-round-repository.js';
import {effectiveTechnicalEvidence} from './development-technical-repository.js';
import {bulkFabricFacts} from './bulk-fabric-facts.js';
type DB=Pick<PoolClient,'query'>;
const iso=(v:Date|string|null|undefined)=>v?new Date(v).toISOString():null;
/** Native records remain authoritative. recorded_at is never substituted for an unknown actual time. */
export async function readSeriesPlanFacts(db:DB,orderId:string,sourceId:string|null,customerCode:string){
 const facts:SeriesObservedFact[]=[],revisions:Record<string,unknown>={};
 const events=(await db.query(`SELECT DISTINCT ON(node_key,scope_ref) *,occurred_date::text AS occurred_date
  FROM digital_series_source_events WHERE production_order_id=$1 ORDER BY node_key,scope_ref,source_version DESC`,[orderId])).rows;
 revisions.events=events.map(e=>[e.event_id,e.source_version,e.voided]);
 const instrumented=new Set(events.map(e=>`${e.node_key}:${e.scope_ref}`));
 for(const e of events)if(!e.voided)facts.push({key:e.node_key,scopeRef:e.scope_ref,sourceDomain:e.source_domain,sourceRecordId:e.source_record_id,sourceVersion:e.source_version,
  completed:true,started:true,occurredAt:iso(e.occurred_at),occurredDate:e.occurred_date?String(e.occurred_date).slice(0,10):null,precision:e.precision,reason:e.reason});
 const fabric=await bulkFabricFacts(db,orderId);revisions.fabric=fabric;
 if(fabric.report&&!instrumented.has('fabric_receipt:whole')){const at=iso(fabric.report.arrivedAt);facts.push({key:'fabric_receipt',scopeRef:'whole',sourceDomain:'bulk-preparation',sourceRecordId:fabric.report.reportId,sourceVersion:1,
  completed:Boolean(at),started:Boolean(at),occurredAt:at,occurredDate:null,precision:at?'instant':'unknown',reason:at?'来自原验布到仓记录':'原验布记录未提供可信到仓时间'});}
 let document:Awaited<ReturnType<typeof developmentDocumentRow>>|null=null;
 if(sourceId){
  document=await developmentDocumentRow(db,sourceId);revisions.development=document?{version:document.version,round:document.round_number,document:document.document}:null;
  if(document){const evidence=await effectiveTechnicalEvidence(db,sourceId,document.round_number,'整款',customerCode);revisions.technical=evidence;
   const comments=(await db.query(`SELECT DISTINCT ON(scope_ref) comment_id,scope_ref,version,decision,occurred_at,customer_code FROM digital_development_final_comments
    WHERE source_id=$1 AND round_number=$2 AND is_final ORDER BY scope_ref,version DESC`,[sourceId,document.round_number])).rows;
   revisions.finalComments=comments.map(c=>[c.comment_id,c.scope_ref,c.version,c.decision,c.customer_code]);
   for(const c of comments){if(instrumented.has(`client_sample_approval:${c.scope_ref==='整款'?'whole':c.scope_ref}`))continue;const ok=c.decision==='approved'&&c.customer_code===customerCode,at=iso(c.occurred_at);
    facts.push({key:'client_sample_approval',scopeRef:c.scope_ref==='整款'?'whole':c.scope_ref,sourceDomain:'development',sourceRecordId:c.comment_id,sourceVersion:c.version,
     completed:ok,started:ok,occurredAt:at,occurredDate:null,precision:at?'instant':'unknown',reason:ok?(at?null:'客户已批复，但实际批复时间未知；不使用录入时间代替'):'最新最终评语尚未批准本客户成果'});
   }
  }
 }
 const sends=(await db.query(`SELECT f.fact_id,f.sequence,f.occurred_at,f.payload FROM digital_factory_facts f JOIN digital_factory_routes r USING(preparation_id)
  WHERE r.production_order_id=$1 AND f.kind='仓库实际发厂' ORDER BY f.sequence`,[orderId])).rows;
 revisions.dispatch=sends.map(f=>[f.fact_id,f.sequence,f.payload]);
 for(const f of sends){const at=iso(f.occurred_at);facts.push({key:'processing_dispatch',scopeRef:`batch:${f.fact_id}`,sourceDomain:'factory-flow',sourceRecordId:f.fact_id,sourceVersion:f.sequence,
  completed:true,started:true,occurredAt:at,occurredDate:null,precision:at?'instant':'unknown',reason:'原仓库实际发厂批次；不代表其他批次已发齐'});}
 if(sends.length&&!instrumented.has('processing_dispatch:whole')){const full=sends.find(f=>!Array.isArray(f.payload?.lines)),last=full??sends.at(-1)!;facts.push({key:'processing_dispatch',scopeRef:'whole',sourceDomain:'factory-flow',sourceRecordId:last.fact_id,sourceVersion:last.sequence,
  completed:Boolean(full),started:true,occurredAt:full?iso(full.occurred_at):null,occurredDate:null,precision:full&&full.occurred_at?'instant':'unknown',reason:full?'原整款仓库发厂记录':'已发部分批次；不将部分发出推断为整单发齐'});}
 return {facts,revisions,document,fabric};
}
/** PR05 native producers call inside their authorized transaction; deliberately not an HTTP command. */
export async function appendSeriesSourceEvent(db:DB,event:SeriesSourceEvent,actorId:string,businessTime:unknown){
 const e=SeriesSourceEventSchema.parse(event);
 await db.query(`INSERT INTO digital_series_source_events(event_id,production_order_id,node_key,scope_ref,source_domain,source_record_id,source_version,occurred_at,occurred_date,precision,supersedes_event_id,voided,reason,created_by,business_time)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[e.eventId,e.orderId,e.key,e.scopeRef,e.sourceDomain,e.sourceRecordId,e.sourceVersion,e.occurredAt,e.occurredDate,e.precision,e.supersedesEventId,e.voided,e.reason,actorId,JSON.stringify(businessTime)]);
}
