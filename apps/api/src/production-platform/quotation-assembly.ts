import {notifySpecialCraftQuotes} from './special-craft-quotation-todos.js';
import {craftStepIdentity,craftStepLabel,type CraftStepChoice} from '@dx-rework/contracts/digital-craft';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import type {BudgetDocument,BudgetRow} from '@dx-rework/contracts/digital-budget';
import {isDevelopmentMaterialPlaceholder,type DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import type {QuotationAssignment,QuotationAssembly,QuotationConsumptionSource} from '@dx-rework/contracts/digital-quotation';
import {developmentDocumentRow} from './development-round-repository.js';
import {publishedTechnicalArtifact,technicalDocumentFingerprint} from './development-technical-repository.js';
import {businessNow} from '../acceptance-clock/business-time.js';

type PriceSource={actorId:string;role:string;version:number;recordedAt:string;documentPriceHash?:string};
export type AssembledQuotation={quote_id:string;source_id:string|null;production_order_id:string|null;version:number;confirmed_version:number|null;document:BudgetDocument;assignments:QuotationAssignment[];consumption_sources:Record<string,QuotationConsumptionSource>;price_sources:Record<string,PriceSource>;assembly?:QuotationAssembly|null};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function rowId(sourceId:string,key:string){const h=digest([sourceId,key]);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}

/** Called by original write commands inside their lifecycle lock/transaction.
 * Re-read current source state rather than applying a potentially late event payload.
 * No GET invokes this writer; confirmed snapshots and budgets are never updated here. */
export async function assembleQuotation(db:PoolClient,sourceId:string,actorId:string,appliedVersion?:number,previousSource?:Awaited<ReturnType<typeof developmentDocumentRow>>):Promise<AssembledQuotation|undefined>{
 const saved=await developmentDocumentRow(db,sourceId);
 if(saved?.document?.quotationMode!=='automatic_v1')return;
 const document=saved.document as DevelopmentDocument,round=saved.round_number??1;
 const source=(await db.query('SELECT s.created_by,o.production_order_id FROM digital_production_sources s LEFT JOIN digital_production_orders o USING(source_id) WHERE s.source_id=$1',[sourceId])).rows[0];
 if(!source)return;
 const old=(await db.query('SELECT * FROM digital_quotation_documents WHERE source_id=$1 FOR UPDATE',[sourceId])).rows[0] as AssembledQuotation|undefined;
 // A historical manual quote is never silently converted, even when source data gains prices.
 if(old&&!old.assembly)return old;
 // A legacy hash can only be upgraded against its actual source version.
 // Document-changing commands provide the pre-write row under the lifecycle lock.
 const legacySource=previousSource??saved;
 const legacyDocument=old?.assembly?.sourceVersion===legacySource?.version&&old?.assembly?.roundNumber===(legacySource?.round_number??1)?legacySource?.document as DevelopmentDocument:undefined;
 const commercialFingerprint=(d:DevelopmentDocument)=>technicalDocumentFingerprint({...d,craft:'无',washing:'免洗'});
 const matches=(id:string,basis:string,legacyBasis:()=>string)=>{
  const ref=old?.assembly?.rows[id];
  return ref?.dependencyVersion===2?ref.basis===basis:Boolean(legacyDocument&&ref?.basis===legacyBasis());
 };
 const artifact=await publishedTechnicalArtifact(db,sourceId,round);
 const validArtifact=artifact?.row.document_fingerprint===technicalDocumentFingerprint(document)?artifact:null;
 const plan=(await db.query("SELECT entries FROM digital_development_round_arrangements WHERE source_id=$1 AND round_number=$2",[sourceId,round])).rows[0]?.entries??{};
 const tasks=(await db.query(`SELECT a.task_kind,a.assignee_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
  WHERE a.source_id=$1 AND t.route_version=$2 AND t.state<>'cancelled' ORDER BY t.created_at,t.task_id`,[sourceId,round])).rows;
 const recipient=(kind:string,fallback:string|null=null):string|null=>{const task=tasks.filter(t=>t.task_kind===kind).at(-1);return task?task.assignee_id:Object.hasOwn(plan,kind)?plan[kind]:fallback;};
 const rows:BudgetRow[]=[],assignments:QuotationAssignment[]=[],consumptions:AssembledQuotation['consumption_sources']={},prices:AssembledQuotation['price_sources']={};
 const refs:QuotationAssembly['rows']={},at=businessNow().toISOString(),nextVersion=appliedVersion??(old?.version??0)+1;
 const add=(row:BudgetRow,assignment:QuotationAssignment,ref:QuotationAssembly['rows'][string])=>{rows.push(row);assignments.push(assignment);refs[row.rowId]=ref;};
 for(const m of document.materials.filter(m=>!isDevelopmentMaterialPlaceholder(m))){
  const id=m.materialId,tech=recipient('development_pattern',old?.assignments.find(a=>a.rowId===id)?.technicalAssigneeId??null),unit=m.pricingUnit??'';
  const basis=digest([m.materialId,m.name,m.specification,unit,commercialFingerprint(document),tech]);
  const prior=old?.document.rows.find(r=>r.rowId===id),same=matches(id,basis,()=>digest([old!.assembly!.roundNumber,m.materialId,m.name,m.specification,unit,technicalDocumentFingerprint(legacyDocument!),tech]))
   &&(!legacyDocument||old?.assembly?.rows[id]?.dependencyVersion===2||commercialFingerprint(legacyDocument)===commercialFingerprint(document));
  const sourceConsumption=validArtifact?.artifact.body.consumptionRows.find(r=>r.materialId===id&&r.unit===unit);
  const artifactRevision=artifact?`${artifact.artifact.artifactSetId}:${artifact.artifact.version}`:'';
  const keepManual=same&&old?.consumption_sources[id]?.kind==='technical_manual'&&old.assembly?.rows[id]?.artifactRevision===artifactRevision;
  let consumption='';
  if(keepManual){consumption=prior?.consumption??'';consumptions[id]=old!.consumption_sources[id]!;}
  else if(sourceConsumption&&sourceConsumption.consumption!==''&&unit){
   consumption=sourceConsumption.consumption;
   const existing=old?.consumption_sources[id];
   consumptions[id]=same&&existing?.artifactRef?.id===validArtifact!.artifact.artifactSetId&&existing.artifactRef.version===validArtifact!.artifact.version?existing:
    {kind:'technical_artifact',actorId:validArtifact!.artifact.createdBy,version:nextVersion,recordedAt:at,artifactRef:{id:validArtifact!.artifact.artifactSetId,version:validArtifact!.artifact.version,materialId:id}};
  }
  else if(same&&old?.consumption_sources[id]?.kind==='technical_artifact'&&artifactRevision&&old.assembly?.rows[id]?.artifactRevision===artifactRevision){
   // A craft-only edit does not revoke an already adopted material quantity.
   // A changed/withdrawn artifact head still requires a valid new source above.
   consumption=prior?.consumption??'';consumptions[id]=old.consumption_sources[id]!;
  }
  const priceBasis=digest([m.unitPrice??'',unit,m.materialId,m.name,m.specification,m.supplier]),override=old?.price_sources[id]?.documentPriceHash===priceBasis;
  const unitPrice=override?prior?.unitPrice??'':m.unitPrice??'';
  if(override&&old?.price_sources[id])prices[id]=old.price_sources[id]!;
  else if(unitPrice!==''&&unit)prices[id]=same&&prior?.unitPrice===unitPrice&&old?.price_sources[id]?old.price_sources[id]!:{actorId:saved.revision?.updated_by??saved.updated_by??source.created_by,role:'development_document',version:saved.version,recordedAt:at};
  add({rowId:id,section:m.category==='辅料'?'辅料':'主料',category:m.category,name:m.name,specification:m.specification,unit,supplier:m.supplier,consumption,unitPrice},
   {rowId:id,technicalAssigneeId:tech,priceAssigneeId:source.created_by,priceRole:'sample_designer'},
   {kind:'material',sourceRef:id,basis,dependencyVersion:2,stage:'development',artifactRevision,priceBasis});
 }
 const component=(key:string,name:string,kind:'ie'|'craft',worker:string|null,priceRole:QuotationAssignment['priceRole'],craftRef?:{libraryId:string;libraryVersion:number;stepId:string|null},stage:'development'|'bulk'='development')=>{
  const id=rowId(sourceId,key),basis=digest([key,commercialFingerprint(document),worker,...(craftRef?[craftRef.libraryId,craftRef.libraryVersion,stage]:[])]),prior=old?.document.rows.find(r=>r.rowId===id);
  const same=matches(id,basis,()=>digest([old!.assembly!.roundNumber,key,technicalDocumentFingerprint(legacyDocument!),legacyDocument!.craftSteps??null,worker]))
   &&(!legacyDocument||old?.assembly?.rows[id]?.dependencyVersion===2||commercialFingerprint(legacyDocument)===commercialFingerprint(document)),unitPrice=same?prior?.unitPrice??'':'';
  if(unitPrice!==''&&old?.price_sources[id])prices[id]=old.price_sources[id]!;
  add({rowId:id,section:'外发工序',category:kind==='ie'?'IE加工':'工艺',name,specification:'',unit:'件',supplier:'',consumption:'1',unitPrice},
   {rowId:id,technicalAssigneeId:null,priceAssigneeId:worker,priceRole},{kind,sourceRef:key,basis,dependencyVersion:2,...(stage==='bulk'?{assignmentVersion:same?old?.assembly?.rows[id]?.assignmentVersion??old?.version??nextVersion:nextVersion}:{}),stage,...(craftRef?{craftRef}:{})});
 };
 const ieId=rowId(sourceId,'ie:processing'),ie=old?.assignments.find(a=>a.rowId===ieId)?.priceAssigneeId??null;
 component('ie:processing','IE加工单价','ie',ie,'ie_reviewer');
 const steps:CraftStepChoice[]=document.craftSteps??(document.craft==='无'?[]:document.craft==='印绣花'?[{craftKind:'embroidery',sequence:1},{craftKind:'printing',sequence:2}]:[{craftKind:document.craft==='印花'?'printing':'embroidery',sequence:1}]);
 // Formal production may add its own special craft. Its price is a distinct
 // input, never the development sample's price copied as a bulk quote.
 const instruction=source.production_order_id?(await db.query(`SELECT v.document,v.version FROM digital_instruction_documents d JOIN digital_instruction_versions v ON v.production_order_id=d.production_order_id AND v.version=d.published_version WHERE d.production_order_id=$1`,[source.production_order_id])).rows[0]:null;
 const bulkSteps:CraftStepChoice[]=instruction?.document?.craftSteps??[];
 const bulkSpecial=bulkSteps.filter(step=>step.craftKind==='special');
 const useBulkSpecial=Boolean(instruction&&(bulkSpecial.length||old?.assembly&&Object.values(old.assembly.rows).some(row=>row.stage==='bulk'&&row.craftRef)||steps.some(step=>step.craftKind==='special')));
 const specialRecipients=steps.some(step=>step.craftKind==='special')?(await db.query(`SELECT s.special_craft_id,s.step_id,a.assignee_id FROM digital_timeline_craft_steps s LEFT JOIN digital_timeline_task_positions p ON p.step_id=s.step_id AND p.phase='work' LEFT JOIN digital_production_task_access a ON a.task_id=p.task_id WHERE s.source_id=$1 AND s.round_number=$2 AND s.craft_kind='special'`,[sourceId,round])).rows:[];
 for(const step of steps.filter(step=>!useBulkSpecial||step.craftKind!=='special')){
  const own=step.specialCraft?specialRecipients.find(row=>row.special_craft_id===step.specialCraft!.id):null;
  const worker=step.craftKind==='special'?own?.assignee_id??(own?plan[`development_printing:${own.step_id}`]??null:null):recipient(`development_${step.craftKind}`);
  component(`craft:${craftStepIdentity(step)}`,craftStepLabel(step),'craft',worker,'pattern_room_worker',step.specialCraft?{libraryId:step.specialCraft.id,libraryVersion:step.specialCraft.version,stepId:own?.step_id??null}:undefined);
 }
 const bulkAdopted=bulkSpecial.length?(await db.query(`SELECT s.special_craft_id,s.special_craft_version,s.step_id FROM digital_bulk_preparations p JOIN digital_timeline_craft_steps s ON s.route_ref=p.preparation_id OR s.route_ref IN (SELECT canonical_route_ref FROM digital_timeline_order_routes WHERE route_ref=p.preparation_id) WHERE p.production_order_id=$1 AND p.instruction_version=$2 AND p.source_round=$3 AND s.craft_kind='special'`,[source.production_order_id,instruction.version,round])).rows:[];
 if(useBulkSpecial)for(const step of bulkSpecial){
  const key=`craft:bulk:${craftStepIdentity(step)}`,id=rowId(sourceId,key);
  const adopted=bulkAdopted.find(row=>row.special_craft_id===step.specialCraft!.id&&row.special_craft_version===step.specialCraft!.version);
  const worker=old?.assignments.find(a=>a.rowId===id)?.priceAssigneeId??null;
  component(key,craftStepLabel(step),'craft',worker,'pattern_room_worker',{libraryId:step.specialCraft!.id,libraryVersion:step.specialCraft!.version,stepId:adopted?.step_id??null},'bulk');
 }
 if(document.washing!=='免洗'){const key=`craft:${document.washing}`;component(key,document.washing,'craft',old?.assignments.find(a=>a.rowId===rowId(sourceId,key))?.priceAssigneeId??null,'embroidery_washing_merchandiser');}
 const output:BudgetDocument={fabricType:old?.document.fabricType??'',productCategory:old?.document.productCategory??document.template,monthSeries:old?.document.monthSeries??'',date:document.orderDate,currency:'人民币',rows,freight:'0',cm:'0',salePrice:'',outsourcingScope:'',outsourcingUnitPrice:'',imageAttachmentIds:[]};
 const priorCraftRows={...old?.assembly?.priorCraftRows};
 for(const [id,ref] of Object.entries(old?.assembly?.rows??{}))if(ref.craftRef&&!refs[id]){
  const row=old!.document.rows.find(row=>row.rowId===id),assignment=old!.assignments.find(a=>a.rowId===id);
  if(row&&assignment)priorCraftRows[id]={row,assignment,ref,...(old!.price_sources[id]?{priceSource:old!.price_sources[id]}:{})};
 }
 const assembly:QuotationAssembly={...(Object.keys(priorCraftRows).length?{priorCraftRows}:{}),schemaVersion:1,sourceVersion:saved.version,roundNumber:round,fingerprint:digest([output,assignments,refs]),rows:refs};
 if(old&&isDeepStrictEqual(old.document,output)&&isDeepStrictEqual(old.assignments,assignments)&&isDeepStrictEqual(old.consumption_sources,consumptions)&&isDeepStrictEqual(old.price_sources,prices)&&isDeepStrictEqual(old.assembly,assembly))return old;
 const quoteId=old?.quote_id??randomUUID();
 const result=await db.query(`INSERT INTO digital_quotation_documents(quote_id,source_id,production_order_id,version,document,assignments,consumption_sources,price_sources,assembly,updated_by)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(quote_id) DO UPDATE SET version=EXCLUDED.version,document=EXCLUDED.document,assignments=EXCLUDED.assignments,
  consumption_sources=EXCLUDED.consumption_sources,price_sources=EXCLUDED.price_sources,assembly=EXCLUDED.assembly,updated_by=EXCLUDED.updated_by,updated_at=CURRENT_TIMESTAMP RETURNING *`,
  [quoteId,sourceId,source.production_order_id??null,nextVersion,JSON.stringify(output),JSON.stringify(assignments),JSON.stringify(consumptions),JSON.stringify(prices),JSON.stringify(assembly),actorId]);
 const assembled=result.rows[0] as AssembledQuotation;await notifySpecialCraftQuotes(db,assembled);return assembled;
}

export function quotationComplete(q:AssembledQuotation){
 return q.document.rows.length>0&&q.document.rows.every(row=>{
  const assignment=q.assignments.find(a=>a.rowId===row.rowId),material=!q.assembly||q.assembly.rows[row.rowId]?.kind==='material';
  return Boolean(row.name&&row.unit&&row.consumption!==''&&row.unitPrice!==''&&assignment?.priceAssigneeId&&q.price_sources[row.rowId]&&(!material||(assignment.technicalAssigneeId&&q.consumption_sources[row.rowId])));
 });
}
