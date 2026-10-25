import {developmentAmendmentsAvailable} from "./development-amendment-repository.js";
import {appliedVerification,effectiveVerificationDocument} from "./development-material-verification.js";
import {isDevelopmentMaterialPlaceholder,isEarlyMaterialException, type DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import type {DevelopmentCheck} from '@dx-rework/contracts/digital-development-execution';
import type {Pool, PoolClient} from 'pg';
import {developmentDocumentRow} from './development-round-repository.js';
import {developmentSlaPlan} from './development-sla-enrollment.js';

type CheckRow = DevelopmentCheck['items'][number];
type Evidence = {id:string;kind:string;items?:CheckRow[];materialId?:string;at:string};
export type MaterialReadiness = {materialId:string;usage?:"use"|"unused"|"pending";name:string;required:boolean;earlyException:boolean;earlyAllowed:boolean;verified:boolean;available:boolean;supplyAvailable:boolean;missing:string[];evidenceId:string|null};
const dimensions = ['physical','quantity','color','specification'] as const;
const labels = {physical:'实物',quantity:'数量',color:'颜色',specification:'规格'};

/** Inputs must already be scoped to a source and an explicit round/inheritance. */
export function effectiveMaterials(document:DevelopmentDocument,evidence:readonly Evidence[],clerkReceiptRequired=false):MaterialReadiness[] {
  return document.materials.map(material=>{
    const facts=evidence.filter(f=>f.materialId===material.materialId||f.items?.some(row=>row.materialId===material.materialId));
    const check=facts.filter(f=>f.items).at(-1);
    const row=check?.items?.find(item=>item.materialId===material.materialId);
    const arrival=facts.filter(f=>f.kind==='到货'||(material.category==='辅料'&&f.kind==='确认代用')).at(-1);
    const arrived=Boolean(arrival&&(!check||new Date(arrival.at).getTime()>new Date(check.at).getTime()));
    const passed=check?.kind==='核配通过';
    const verified=Boolean(passed&&row&&dimensions.every(key=>row[key]));
    const earlyException=clerkReceiptRequired?material.category==='辅料':isEarlyMaterialException(material);
    // An arrival can resolve an explicitly recorded missing exception. It cannot
    // certify omitted ordinary checks or overrule an actual quality mismatch.
    const resolvedException=!clerkReceiptRequired&&Boolean(passed&&row&&!row.physical&&earlyException&&arrived);
    const available=verified||resolvedException;
    const missing=!material.requiredThisRound||available?[]:!row?['尚未逐项核验']:dimensions.filter(key=>!row[key]).map(key=>`${labels[key]}未核实`);
    if(material.requiredThisRound&&check?.kind==='缺项退回')missing.push('核料已退回，尚未复核通过；设计师处理本单补正／补料待办后，由开发文员在我的待办复核');
    const earlyAllowed=earlyException&&Boolean(row&&!row.physical&&check?.kind==='核配通过');
    // Designer delivery may submit the original supply task for clerk recheck.
    // It does not establish verified availability, sewing release or clerk receipt.
    const supplyAvailable=clerkReceiptRequired&&material.category==='辅料'&&check?.kind!=='缺项退回'?Boolean(row?.physical):row?row.physical||arrived:material.available||arrived;
    return {materialId:material.materialId,name:material.label||material.name||'未命名物料',required:material.requiredThisRound,earlyException,earlyAllowed,verified,available,supplyAvailable,missing,evidenceId:(resolvedException?arrival?.id:check?.id)??null};
  });
}

export function materialCheckError(material:DevelopmentDocument['materials'][number],row:CheckRow|undefined,note:string,expectedDate:string|null,clerkReceiptRequired=false):string|null {
  const name=material.label||material.name||'未命名物料';
  if(!row)return `${name}须登记本轮核验结果`;
  if((clerkReceiptRequired?material.category==='辅料':isEarlyMaterialException(material))&&!row.physical){
    return expectedDate&&note.trim()?null:`${name}未到：请填写预计到料日期及缺项说明，由设计师跟进`;
  }
  const missing=dimensions.filter(key=>!row[key]).map(key=>labels[key]);
  return missing.length?`${name}的${missing.join('、')}须核实`:null;
}

export async function materialReadiness(db:Pick<Pool|PoolClient,'query'>,sourceId:string,roundNumber:number){
  const saved=await developmentDocumentRow(db,sourceId,roundNumber);
  if(!saved)return {documentMissing:true,materials:[] as MaterialReadiness[],quality:[] as {id:string}[],supplyMissing:[] as MaterialReadiness[],earlyMissing:[] as MaterialReadiness[],sewingMissing:[] as MaterialReadiness[],earlyReady:false,sewingReady:false};
  const inherited=saved.revision?.inherited?.development_materials?.taskId??null;
  const facts=(await db.query(`SELECT f.fact_id AS id,f.kind,f.payload,f.recorded_at AS at
    FROM digital_development_execution_facts f JOIN digital_production_tasks t ON t.task_id=f.task_id
    JOIN digital_production_task_access a ON a.task_id=t.task_id
    WHERE f.source_id=$1 AND a.source_id=$1 AND f.kind IN ('核配通过','缺项退回')
      AND (t.route_version=$2 OR (t.task_id=$3 AND t.state='completed'))
    ORDER BY (t.route_version=$2),f.sequence`,[sourceId,roundNumber,inherited])).rows;
  const hasRounds=Boolean(saved.revision)||saved.latest_round_number>1||Boolean((await db.query("SELECT to_regclass('digital_development_rounds') AS relation")).rows[0]?.relation);
  const events=(await db.query(`SELECT event_id AS id,material_id AS "materialId",action AS kind,created_at AS at
    FROM digital_development_material_events WHERE source_id=$1 ${hasRounds?`AND (route_version=$2 OR route_version=(SELECT t.route_version FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE t.task_id=$3 AND a.source_id=$1 AND t.state='completed'))`:''} ORDER BY sequence`,hasRounds?[sourceId,roundNumber,inherited]:[sourceId])).rows;
  const materials=effectiveMaterials(await effectiveVerificationDocument(db,sourceId,roundNumber,saved.document as DevelopmentDocument),[...facts.map(f=>({...f,at:new Date(f.at).toISOString(),items:f.payload.items??[]})),...events.map(e=>({...e,at:new Date(e.at).toISOString()}))],Boolean(await developmentSlaPlan(db,sourceId)));
  const applied=await appliedVerification(db,sourceId,roundNumber,saved.document);
  if(applied)for(const material of materials){const row=applied.find(r=>r.materialId===material.materialId);if(row)material.usage=row.invalidated.length?'pending':row.usage;if(row&&(row.usage==='pending'||row.invalidated.length)){material.available=false;material.earlyAllowed=false;material.missing.push(...(row.invalidated.length?row.invalidated:['本轮材料使用情况待文员确认']));}}
  if(!applied&&await developmentAmendmentsAvailable(db)){
    const amended=(await db.query("SELECT published_at FROM digital_development_amendments WHERE source_id=$1 AND round_number=$2 ORDER BY document_version DESC LIMIT 1",[sourceId,roundNumber])).rows[0];
    if(amended)for(const material of materials)if(saved.document.materials.some((row:DevelopmentDocument["materials"][number])=>row.materialId===material.materialId&&!isDevelopmentMaterialPlaceholder(row))){material.required=true;material.usage="pending";material.available=false;material.earlyAllowed=false;material.missing.push("资料已补正，原核验缺少可沿用依据，请文员重新确认本轮使用及四项");}
  }
  const quality=(await db.query(`SELECT f.fact_id AS id FROM digital_development_execution_facts f
    WHERE f.source_id=$1 AND f.kind='面料报告' AND f.payload->>'recommendation'='建议停用'
      AND COALESCE((SELECT d.payload->>'decision' FROM digital_development_execution_facts d
        WHERE d.source_id=$1 AND d.kind='面料决定' AND d.payload->>'reportId'=f.fact_id::text
        ORDER BY d.sequence DESC LIMIT 1),'')<>'允许使用'`,[sourceId])).rows;
  if(quality.length)for(const material of materials)if(material.required){
    material.available=false;material.earlyAllowed=false;
    material.missing.push('面料停用／质量决定待处理');
  }
  const supplyMissing=materials.filter(m=>m.required&&!m.supplyAvailable&&!m.earlyException);
  const earlyMissing=materials.filter(m=>m.required&&!m.available&&!m.earlyAllowed);
  const sewingMissing=materials.filter(m=>m.required&&!m.available);
  return {documentMissing:false,materials,quality,supplyMissing,earlyMissing,sewingMissing,earlyReady:!earlyMissing.length&&!quality.length,sewingReady:!sewingMissing.length&&!quality.length};
}
