import type {Pool,PoolClient} from 'pg';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import type {DevelopmentReturnIssue} from '@dx-rework/contracts/digital-development-amendments';
import {MATERIAL_CHECK_FIELDS,MATERIAL_CHECK_LABELS,type MaterialBulkRules} from '@dx-rework/contracts/digital-development-execution';
import {developmentSlaPlan} from './development-sla-enrollment.js';
type DB=Pick<Pool|PoolClient,'query'>;
type Check={kind:string;items:Array<{materialId:string;physical:boolean}>;at:string};
type Arrival={materialId:string;at:string};
type Quality={materialIds?:string[]};
/** Only structured facts determine conflicts; unchecked values and free notes are not inferred mismatches. */
export function materialBulkRules(document:DevelopmentDocument,latest:Check|null,arrivals:Arrival[],issues:DevelopmentReturnIssue[],quality:Quality[],supplementalAccessoryCheck=false,returnedMaterialIds:readonly string[]=[]):MaterialBulkRules{
 return document.materials.map(material=>{
  const prior=latest?.items.find(row=>row.materialId===material.materialId);
  const arrived=arrivals.some(row=>row.materialId===material.materialId&&(!latest||new Date(row.at).getTime()>new Date(latest.at).getTime()));
  const physicalMissing=Boolean(prior&&!prior.physical&&!arrived);
  const available=arrived||(prior?prior.physical:material.available);
  // A manually checked accessory can acquire its first receipt through the
  // original supplemental submission. A bulk select cannot supply that fact.
  const canVerifyArrival=supplementalAccessoryCheck&&material.category==='辅料'&&latest?.kind==='核配通过'&&physicalMissing;
  const returnedForClerk=returnedMaterialIds.includes(material.materialId);
  const checks=Object.fromEntries(MATERIAL_CHECK_FIELDS.map(field=>{
   const issue=issues.find(row=>row.materialId===material.materialId&&row.field===field);
   const qualityBlocked=quality.some(row=>!row.materialIds?.length||row.materialIds.includes(material.materialId));
   const manualArrival=(returnedForClerk||field==='physical'&&canVerifyArrival)&&!qualityBlocked;
   const knownConflict=Boolean(issue)||(field==='physical'&&physicalMissing&&!manualArrival);
   const reason=issue?`${MATERIAL_CHECK_LABELS[field]}尚有退回问题：${issue.reason}；请设计师处理原补正／补料事项后重新读取`:manualArrival?(returnedForClerk?'请逐项核实退回材料，正式提交复核后才生效':'请逐项核实实物，提交补核后才记录到料'):field==='physical'&&!available?'暂无实物到料依据；请核实实物，缺料例外不能勾成已到':qualityBlocked?'材料有待决定／停用质量报告，请供应链总监或 Root 在本单处理后重新读取':field!=='physical'&&!material[field].trim()?`${{quantity:'数量',color:'颜色',specification:'规格'}[field]}资料未登记，不能批量判定相符；请先核实资料`:null;
   return [field,{canSelect:reason===null,reason,knownConflict}];
  })) as MaterialBulkRules[number]['checks'];
  return {materialId:material.materialId,checks};
 });
}
/** This internal basis is emitted only by the original supply submission. */
export async function readMaterialRecheckBasis(db:DB,sourceId:string,round:number,taskId:string,documentVersion:number){
 const row=(await db.query<{payload:{supplemental?:boolean;receiptMaterialIds?:string[];receiptDocumentVersion?:number}}>(`SELECT f.payload FROM digital_development_execution_facts f
   JOIN digital_production_tasks t ON t.task_id=f.task_id
   JOIN digital_production_task_access a ON a.task_id=t.task_id AND a.source_id=f.source_id
   WHERE f.source_id=$1 AND t.route_version=$2 AND f.task_id=$3 AND t.state='ready' AND a.task_kind='development_material_recheck'
     AND f.kind='补料复核' AND (f.payload->>'supplemental'='true' OR f.payload ? 'receiptMaterialIds')
   ORDER BY f.sequence DESC LIMIT 1`,[sourceId,round,taskId])).rows[0]?.payload;
 const receiptVersionChanged=Boolean(row?.receiptMaterialIds?.length&&row.receiptDocumentVersion!==documentVersion);
 return {supplemental:row?.supplemental===true,receiptMaterialIds:receiptVersionChanged?[]:row?.receiptMaterialIds??[],receiptVersionChanged};
}
/** Caller already scopes source access and holds the lifecycle transaction for writes. */
export async function readMaterialBulkRules(db:DB,sourceId:string,round:number,document:DevelopmentDocument,documentVersion:number,checkTaskId?:string):Promise<MaterialBulkRules>{
 const latest=(await db.query(`SELECT f.kind,f.payload->'items' AS items,f.recorded_at::text AS at FROM digital_development_execution_facts f JOIN digital_production_tasks t ON t.task_id=f.task_id WHERE f.source_id=$1 AND t.route_version=$2 AND f.kind IN ('核配通过','缺项退回') ORDER BY f.sequence DESC LIMIT 1`,[sourceId,round])).rows[0]??null;
 const arrivals=(await db.query(`SELECT material_id AS "materialId",created_at::text AS at FROM digital_development_material_events WHERE source_id=$1 AND route_version=$2 AND action IN ('到货','确认代用')`,[sourceId,round])).rows;
 const returns=(await db.query(`SELECT f.payload->'returnRequirements'->'issues' AS issues FROM digital_development_execution_facts f JOIN digital_production_tasks t ON t.task_id=f.task_id WHERE f.source_id=$1 AND t.route_version=$2 AND f.kind='补料复核' AND f.payload ? 'returnRequirements' AND t.state IN ('pending','ready','blocked') ORDER BY f.sequence`,[sourceId,round])).rows;
 const quality=(await db.query(`SELECT f.payload->'materialIds' AS "materialIds" FROM digital_development_execution_facts f WHERE f.source_id=$1 AND f.kind='面料报告' AND f.payload->>'recommendation'='建议停用' AND coalesce((SELECT d.payload->>'decision' FROM digital_development_execution_facts d WHERE d.source_id=$1 AND d.kind='面料决定' AND d.payload->>'reportId'=f.fact_id::text ORDER BY d.sequence DESC LIMIT 1),'')<>'允许使用'`,[sourceId])).rows;
 const basis=checkTaskId?await readMaterialRecheckBasis(db,sourceId,round,checkTaskId,documentVersion):null;
 const supplemental=basis?.supplemental&&latest?.kind==='核配通过'&&latest.items?.some((item:Check['items'][number])=>!item.physical);
 return materialBulkRules(document,latest,arrivals,returns.flatMap(row=>row.issues??[]),quality,Boolean(supplemental&&await developmentSlaPlan(db,sourceId)),basis?.receiptMaterialIds);
}
