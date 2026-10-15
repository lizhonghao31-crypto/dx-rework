import {isEarlyMaterialException, type DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import type {DevelopmentCheck} from '@dx-rework/contracts/digital-development-execution';
import type {Pool, PoolClient} from 'pg';
import {developmentDocumentRow} from './development-round-repository.js';

type CheckRow = DevelopmentCheck['items'][number];
type Evidence = {id:string;kind:string;items?:CheckRow[];materialId?:string;at:string};
export type MaterialReadiness = {materialId:string;name:string;required:boolean;earlyException:boolean;earlyAllowed:boolean;verified:boolean;available:boolean;supplyAvailable:boolean;missing:string[];evidenceId:string|null};
const dimensions = ['physical','quantity','color','specification'] as const;
const labels = {physical:'实物',quantity:'数量',color:'颜色',specification:'规格'};

/** Inputs must already be scoped to a source and an explicit round/inheritance. */
export function effectiveMaterials(document:DevelopmentDocument,evidence:readonly Evidence[]):MaterialReadiness[] {
  return document.materials.map(material=>{
    const facts=evidence.filter(f=>f.materialId===material.materialId||f.items?.some(row=>row.materialId===material.materialId));
    const check=facts.filter(f=>f.items).at(-1);
    const row=check?.items?.find(item=>item.materialId===material.materialId);
    const arrival=facts.filter(f=>f.kind==='到货'||(material.category==='辅料'&&f.kind==='确认代用')).at(-1);
    const arrived=Boolean(arrival&&(!check||new Date(arrival.at).getTime()>new Date(check.at).getTime()));
    const verified=Boolean(row&&dimensions.every(key=>row[key]));
    const earlyException=isEarlyMaterialException(material);
    // An arrival can resolve an explicitly recorded missing exception. It cannot
    // certify omitted ordinary checks or overrule an actual quality mismatch.
    const resolvedException=Boolean(row&&!row.physical&&earlyException&&arrived);
    const available=verified||resolvedException;
    const missing=!material.requiredThisRound||available?[]:!row?['尚未逐项核验']:dimensions.filter(key=>!row[key]).map(key=>`${labels[key]}未核实`);
    const earlyAllowed=earlyException&&Boolean(row&&!row.physical&&check?.kind==='核配通过');
    const supplyAvailable=row?row.physical||arrived:material.available||arrived;
    return {materialId:material.materialId,name:material.label||material.name||'未命名物料',required:material.requiredThisRound,earlyException,earlyAllowed,verified,available,supplyAvailable,missing,evidenceId:(resolvedException?arrival?.id:check?.id)??null};
  });
}

export function materialCheckError(material:DevelopmentDocument['materials'][number],row:CheckRow|undefined,note:string,expectedDate:string|null):string|null {
  const name=material.label||material.name||'未命名物料';
  if(!row)return `${name}须登记本轮核验结果`;
  if(isEarlyMaterialException(material)&&!row.physical){
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
  const materials=effectiveMaterials(saved.document as DevelopmentDocument,[...facts.map(f=>({...f,at:new Date(f.at).toISOString(),items:f.payload.items??[]})),...events.map(e=>({...e,at:new Date(e.at).toISOString()}))]);
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
