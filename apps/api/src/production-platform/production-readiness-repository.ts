import {randomUUID} from 'node:crypto';
import {readStyleLabelReadiness} from './style-label-readiness.js';
import type {PreparationWindow} from '@dx-rework/contracts/production-readiness';
import {businessNow} from '../acceptance-clock/business-time.js';
import {bulkFabricFacts} from './bulk-fabric-facts.js';
import {developmentDocumentRow} from './development-round-repository.js';
import {effectiveTechnicalEvidence} from './development-technical-repository.js';
import {preparationAdoption,preparationAvailable,preparationContext,preparationHash,preparationIso,currentPreparationMaterials,preparationMaterialHistory,type PreparationDB} from './preparation-material-repository.js';
import {orderTimePolicyAt} from './order-time-native-timing.js';
import {orderTimeRule} from '@dx-rework/contracts/order-time-plan';
import {shiftFixedTimeline} from './fixed-timeline-targets.js';

/** Shared by original instruction commands, bulk gates, SLA and the UI. Reads never start clocks or adopt a plan. */
export async function productionReadiness(db:PreparationDB,orderId:string){
 const context=await preparationContext(db,{kind:'order',id:orderId});
 const adoption=await preparationAdoption(db,{kind:'order',id:orderId});
 const document=context.sourceId?await developmentDocumentRow(db,context.sourceId):null;
 const technical=context.sourceId&&document?await effectiveTechnicalEvidence(db,context.sourceId,document.round_number,'整款',context.order.customer_code):null;
 const materialHistory=await preparationMaterialHistory(db,context),materials=currentPreparationMaterials(materialHistory,orderId);
 const receipt=materials.find(f=>f.kind==='fabric_receipt'&&f.scopeRef==='whole')??null;
 const fabric=await bulkFabricFacts(db,orderId);
 const basis=context.sourceId&&document?(await db.query('SELECT * FROM digital_development_preparation_basis WHERE source_id=$1 AND round_number=$2 ORDER BY version DESC LIMIT 1',[context.sourceId,document.round_number])).rows[0]:null;
 let repeat=false;
 if(basis?.basis==='confirmed_repeat'&&basis.sample_evidence_ids.length&&basis.customer_fabric_evidence_ids.length){
  const ids=[...new Set<string>([...basis.sample_evidence_ids,...basis.customer_fabric_evidence_ids])];
  repeat=(await db.query("SELECT count(*)::int AS n FROM attachments WHERE attachment_id=ANY($1::uuid[]) AND status='ready'",[ids])).rows[0].n===ids.length;
 }
 const tail=context.sourceId&&document?(await db.query(`SELECT f.kind,f.task_id,f.payload,t.completed_at FROM digital_development_route_facts f
  LEFT JOIN digital_production_tasks t ON t.task_id=f.task_id WHERE f.source_id=$1 AND f.route_version=$2 AND f.kind IN ('尾查通过','尾查退回') ORDER BY f.sequence DESC LIMIT 1`,[context.sourceId,document.round_number])).rows[0]:null;
 const finalReasons:string[]=[];
 if(!technical||technical.state!=='effective')finalReasons.push('客户最终批复及本次技术尺寸复核尚未形成有效走货依据');
 if(!repeat&&tail?.kind!=='尾查通过')finalReasons.push('本轮尾查未通过；已有首版的复版须提供原首版和客户面料确认依据');
 const scopedInspection=fabric.warehouseInspection;
 if(!scopedInspection&&receipt&&(!receipt.valid||receipt.state!=='ready'))finalReasons.push('当前主料到仓记录尚未有效备齐');
 if(!fabric.usable)finalReasons.push('主料未通过验布或尚无有效允许使用决定');
 const receiptAt=scopedInspection?scopedInspection.firstReceiptAt:receipt&&['ready','partial'].includes(receipt.state)&&receipt.valid?receipt.occurredAt:!receipt?fabric.report?.arrivedAt??null:null;
 if(scopedInspection?!scopedInspection.firstReceiptAt:!receiptAt&&!receipt&&!fabric.report?.arrivedAt)finalReasons.push('尚未登记主料实际到仓');
 const timeRows=technical?.finalCommentRef?(await db.query(`SELECT c.recorded_at,r.reviewed_at FROM digital_development_final_comments c
  LEFT JOIN digital_development_size_review_requests q ON q.final_comment_id=c.comment_id
  LEFT JOIN digital_development_size_review_results r USING(review_id) WHERE c.comment_id=$1`,[technical.finalCommentRef.id])).rows[0]:null;
 // For confirmed_repeat, created_at is the designer's explicit native confirmation at businessNow,
 // not an attachment upload or a warehouse/audit timestamp. It is itself a prerequisite.
 const times=[fabric.usableAt,preparationIso(timeRows?.recorded_at),preparationIso(timeRows?.reviewed_at),...(repeat?[preparationIso(basis?.created_at)]:[preparationIso(tail?.task_id?tail.completed_at:tail?.payload?.actualCompletedAt)])];
 const readyAt=!finalReasons.length&&times.every(Boolean)?new Date(Math.max(...times.map(t=>Date.parse(t!)))).toISOString():null;
 const revision=preparationHash({adoption:adoption?.adoption_id??null,source:document?[document.round_number,document.version]:null,
  technical:technical?.revision??null,tail:tail??null,repeat,basis:basis?[basis.version,basis.sample_evidence_ids,basis.customer_fabric_evidence_ids]:null,
  materials:materials.map(f=>[f.recordId,f.version,f.valid]),fabric});
 return {context,adoption,document,technical,materials,materialHistory,receipt,fabric,receiptAt,finalReasons,readyAt,revision};
}

export async function refreshPreparationWindows(db:PreparationDB,orderId:string){
 if(!await preparationAvailable(db))return;
 const receiptExists=(await db.query(`SELECT 1 FROM digital_preparation_material_versions m JOIN digital_production_orders o ON o.production_order_id=$1 WHERE m.kind='fabric_receipt' AND ((m.resource_kind='order' AND m.resource_id=o.production_order_id) OR (m.resource_kind='source' AND m.resource_id=o.source_id)) UNION ALL SELECT 1 FROM digital_production_task_events WHERE resource_kind='order' AND resource_id=$1 AND event_kind='bulk_fabric_report' LIMIT 1`,[orderId])).rowCount;
 if(!receiptExists)return;
 const state=await productionReadiness(db,orderId);if(!state.adoption)return;
 const managed=(await db.query("SELECT to_jsonb(o)->>'order_time_managed' AS managed FROM digital_production_orders o WHERE production_order_id=$1",[orderId])).rows[0]?.managed==='true';
 for(const [kind,at,minutes] of [['draft',state.receiptAt,state.adoption.standards.draftMinutes],['final',!state.finalReasons.length?state.readyAt:null,state.adoption.standards.finalMinutes]] as const){
  if(!at||kind==='draft'&&state.adoption.standards.retainedDraftVersion>0||kind==='final'&&state.adoption.standards.retainedInstructionVersion&&state.adoption.standards.retainedTechnicalRevision===state.technical?.revision)continue;
  const chosen=managed?await orderTimePolicyAt(db,{kind:'order',id:orderId},at):null,rule=chosen?orderTimeRule(chosen.plan,'production_sheet')?.rule:null;
  const quota=chosen?rule?.kind==='work'?rule.minutes:null:minutes,calendar=chosen?rule?.calendar??null:'continuous';
  if(quota===null||!calendar)continue;
  const dueAt=shiftFixedTimeline(at,quota,calendar),basis={readinessRevision:state.revision,technicalRevision:state.technical?.revision??null,receipt:state.receipt?[state.receipt.recordId,state.receipt.version]:null,
   ...(chosen?{orderTimePlanRef:chosen.id,calendarRef:calendar,warningPercent:rule!.reminder.percent,notificationEnabled:rule!.reminder.enabled}:{})};
  await db.query(`INSERT INTO digital_preparation_windows(window_id,production_order_id,kind,epoch,adoption_id,started_at,due_at,minutes,basis_json)
   VALUES($1,$2,$3,1,$4,$5,$6,$7,$8) ON CONFLICT(production_order_id,kind,epoch) DO NOTHING`,
   [randomUUID(),orderId,kind,state.adoption.adoption_id,at,dueAt,quota,JSON.stringify(basis)]);
 }
}
export async function recordInstructionWork(db:PreparationDB,actorId:string,orderId:string,kind:'draft_saved'|'published',version:number,basis:unknown={}){
 if(!await preparationAvailable(db))return;
 if(!await preparationAdoption(db,{kind:'order',id:orderId}))return;
 await refreshPreparationWindows(db,orderId);
 await db.query(`INSERT INTO digital_preparation_instruction_events(event_id,production_order_id,kind,instruction_version,occurred_at,actor_id,body)
  VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(production_order_id,kind,instruction_version) DO NOTHING`,[randomUUID(),orderId,kind,version,businessNow().toISOString(),actorId,JSON.stringify(basis)]);
}
export async function readPreparationWindow(db:PreparationDB,orderId:string,kind:'draft'|'final',reasons:string[]=[]){
 const empty:PreparationWindow={startedAt:null,dueAt:null,completedAt:null,minutes:null,reason:null,status:'waiting'};
 if(!await preparationAvailable(db))return {window:empty,basis:null};
 const row=(await db.query('SELECT * FROM digital_preparation_windows WHERE production_order_id=$1 AND kind=$2 ORDER BY epoch DESC LIMIT 1',[orderId,kind])).rows[0];

 const completion=(await db.query(`SELECT occurred_at FROM digital_preparation_instruction_events WHERE production_order_id=$1 AND kind=$2 ORDER BY instruction_version,occurred_at LIMIT 1`,[orderId,kind==='draft'?'draft_saved':'published'])).rows[0];
 if(!row)return {window:{...empty,completedAt:preparationIso(completion?.occurred_at),status:completion?'unknown' as const:'waiting' as const,reason:reasons.length?reasons.join('；'):'尚无可信起点，不以创建或读取时间代替'},basis:null};
 const startedAt=preparationIso(row.started_at),dueAt=preparationIso(row.due_at),completedAt=preparationIso(completion?.occurred_at);
 const window:PreparationWindow={startedAt,dueAt,completedAt,minutes:row.minutes,reason:!completedAt&&reasons.length?reasons.join('；'):completedAt&&startedAt&&completedAt<startedAt?'已提前办理，保留真实发生时间':null,
  status:!startedAt||!dueAt?'unknown':completedAt?completedAt<=dueAt?'completed_on_time':'completed_late':businessNow().toISOString()>dueAt?'overdue':'running'};
 return {window,basis:row.basis_json};
}
export async function preparationWindow(db:PreparationDB,orderId:string,kind:'draft'|'final',reasons:string[]=[]):Promise<PreparationWindow>{
 return (await readPreparationWindow(db,orderId,kind,reasons)).window;
}
export async function instructionTechnicalCurrent(db:PreparationDB,orderId:string,instructionVersion:number,technicalRevision:string|null){
 const adoption=await preparationAdoption(db,{kind:'order',id:orderId});if(!adoption)return true;
 if(adoption.standards.retainedInstructionVersion>=instructionVersion&&(adoption.standards.retainedTechnicalRevision===technicalRevision||technicalRevision===null&&adoption.standards.retainedTechnicalRevision?.startsWith('legacy:')))return true;
 const basis=(await db.query('SELECT technical_revision FROM digital_instruction_preparation_bases WHERE production_order_id=$1 AND instruction_version=$2',[orderId,instructionVersion])).rows[0];
 return Boolean(basis&&technicalRevision&&basis.technical_revision===technicalRevision);
}
/** Physical labels belong to the concrete cutting range, not the global preparation/production gate. */
export async function styleLabelCuttingReason(db:PreparationDB,orderId:string,lineIds:string[],requiredQuantity?:number){
 if(!await preparationAdoption(db,{kind:'order',id:orderId}))return null;
 if(!lineIds.length)return '开裁款色关联不完整，请从原裁床单核对，不推断款号唛已齐';
 const {result}=await readStyleLabelReadiness(db,orderId,lineIds.map(lineId=>({kind:'actual_cut',lineId,...(requiredQuantity!==undefined?{requiredQuantity}:{})})),{adopted:true});
 return result.every(row=>row&&'status' in row&&row.status==='sufficient')?null:'本次开裁款色的款号唛实物尚未有效备齐，请指定仓管核实物料；不影响无关纸样唛架准备';
}

/** Technical department owns the existing report; warehouse completion does not stand in for technical confirmation. */
export async function preparationTestReasons(db:PreparationDB,orderId:string,preshrink=false){
 if(!await preparationAdoption(db,{kind:'order',id:orderId}))return [] as string[];
 const context=await preparationContext(db,{kind:'order',id:orderId}),document=context.sourceId?await developmentDocumentRow(db,context.sourceId):null;
 if(!document)return ['当前物料技术依据尚未形成'];
 const budget=(await db.query('SELECT document FROM digital_budget_documents WHERE production_order_id=$1',[orderId])).rows[0];
 const knit=budget?.document.fabricType==='针织';
 const rows=(await db.query('SELECT DISTINCT ON(material_id) * FROM digital_development_technical_material_decisions WHERE source_id=$1 AND round_number=$2 ORDER BY material_id,version DESC',[context.sourceId,document.round_number])).rows;
 const reasons:string[]=[];
 for(const material of document.document.materials.filter((m:{category:string;name:string})=>m.category!=='辅料'&&m.name.trim())){
  const report=rows.find(r=>r.material_id===material.materialId);
  if(!report||report.high_temperature_required===null){reasons.push(`${material.name}：高温测试适用判断尚未由技术确认`);continue;}
  if(preshrink||report.high_temperature_required){
   if(report.warp_shrink_percent===null||report.weft_shrink_percent===null||!report.supplier_evidence_ids.length)reasons.push(`${material.name}：请技术确认经纬缩率及原报告`);
   if(report.supplier_evidence_ids.length&&(await db.query("SELECT count(*)::int AS n FROM attachments WHERE attachment_id=ANY($1::uuid[]) AND status='ready'",[report.supplier_evidence_ids])).rows[0].n!==report.supplier_evidence_ids.length)reasons.push(`${material.name}：测试报告已失效`);
  }
  if(preshrink&&(!report.preshrink_method||knit&&report.preshrink_method!=='专业针织预缩'))reasons.push(`${material.name}：${knit?'针织须专业预缩，不以普通混洗代替':'预缩方法尚未由技术确认'}`);
 }
 return reasons;
}
