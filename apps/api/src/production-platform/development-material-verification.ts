import {developmentAmendmentsAvailable} from "./development-amendment-repository.js";
import type {DevelopmentReturnIssue} from "@dx-rework/contracts/digital-development-amendments";
import {isDeepStrictEqual} from "node:util";
import {randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {isDevelopmentMaterialPlaceholder,type DevelopmentDocument,type DevelopmentMaterial} from "@dx-rework/contracts/digital-development";
import type {MaterialVerification,MaterialVerificationEntry} from "@dx-rework/contracts/digital-development-execution";
import type {TrustedActorContext} from "../tools/repositories.js";
import {ApplicationError} from "../platform/errors.js";
type DB=Pick<Pool|PoolClient,"query">;
type Stored=MaterialVerificationEntry&{basis:DevelopmentMaterial;changedBy:string;changedAt:string};
export const verificationAvailable=async(db:DB)=>Boolean((await db.query("SELECT to_regclass('digital_development_material_verifications') AS relation")).rows[0]?.relation);
export async function readMaterialVerification(db:DB,sourceId:string,round:number,document:DevelopmentDocument,documentVersion:number):Promise<MaterialVerification|null>{
 if(!await verificationAvailable(db))return null;
 const saved=(await db.query("SELECT * FROM digital_development_material_verifications WHERE source_id=$1 AND round_number=$2",[sourceId,round])).rows[0];
 const old:Stored[]=saved?.entries??[];
 const entries=verificationRows(document,old);
 if(!saved&&!(await developmentAmendmentsAvailable(db)&&(await db.query("SELECT 1 FROM digital_development_amendments WHERE source_id=$1 AND round_number=$2",[sourceId,round])).rowCount)){
  const prior=(await db.query(`SELECT f.payload FROM digital_development_execution_facts f JOIN digital_production_tasks t ON t.task_id=f.task_id
   WHERE f.source_id=$1 AND t.route_version=$2 AND f.kind IN ('核配通过','缺项退回') ORDER BY f.sequence DESC LIMIT 1`,[sourceId,round])).rows[0];
  for(const entry of entries){const reference=prior?.payload.items?.find((r:MaterialVerificationEntry)=>r.materialId===entry.materialId);if(reference){
   for(const key of ['physical','quantity','color','specification'] as const)entry[key]=reference[key]===true;
   entry.invalidated.push("已带入同轮历史四项结果供复核；本轮使用情况仍待文员确认，保存不会自动完成核料");
  }}
 }
 const people=(await db.query("SELECT id,display_name FROM app_users WHERE id=ANY($1::uuid[])",[entries.map(e=>e.changedBy).filter(Boolean)])).rows;
 for(const entry of entries)entry.changedBy=people.find(p=>p.id===entry.changedBy)?.display_name??entry.changedBy;
 return {returnIssues:saved?.draft_return_issues??[],version:saved?.version??0,documentVersion,taskId:saved?.task_id??null,note:saved?.draft_note??"",result:saved?.draft_result??"通过",entries};
}
export function verificationRows(document:DevelopmentDocument,old:Stored[]){
 return document.materials.filter(m=>!isDevelopmentMaterialPlaceholder(m)||old.some(r=>r.materialId===m.materialId)).map(m=>{
  const prior=old.find(r=>r.materialId===m.materialId);
  const invalidated:string[]=[];
  const sameIdentity=prior&&["name","category","supplier","composition","width","weight","auxiliaryKind"].every(k=>prior.basis[k as keyof DevelopmentMaterial]===m[k as keyof DevelopmentMaterial]);
  const value:MaterialVerification["entries"][number]={materialId:m.materialId,usage:sameIdentity?prior.usage:"pending",physical:sameIdentity?prior.physical:false,quantity:sameIdentity?prior.quantity:false,color:sameIdentity?prior.color:false,specification:sameIdentity?prior.specification:false,note:sameIdentity?prior.note:"",confirmedWith:sameIdentity?prior.confirmedWith:"",changedBy:prior?.changedBy??null,changedAt:prior?.changedAt??null,invalidated};
  if(prior&&!sameIdentity)invalidated.push("材料已变更，请重新确认本轮使用情况及四项核验");
  if(sameIdentity){
   for(const key of ["quantity","color","specification"] as const)if(prior.basis[key]!==m[key]){value[key]=false;invalidated.push(`${{quantity:"数量",color:"颜色",specification:"规格"}[key]}资料已变更，须重新核验`);}
   if(prior.basis.available!==m.available){value.physical=false;invalidated.push("实物资料已变更，须重新核验");}
  }
  return value;
 });
}
export async function saveMaterialVerification(db:PoolClient,actor:TrustedActorContext,sourceId:string,round:number,document:DevelopmentDocument,documentVersion:number,input:{taskId:string;expectedVersion:number;expectedDocumentVersion:number;entries:MaterialVerificationEntry[];note?:string;result?:string;returnIssues?:DevelopmentReturnIssue[]|undefined}){
 const current=await readMaterialVerification(db,sourceId,round,document,documentVersion);
 const fail=(text:string):never=>{throw new ApplicationError("DEVELOPMENT_CONFLICT",text,409);};
 if(!current)fail("材料确认功能尚未就绪，请联系管理员核实版本");
 if(input.expectedVersion!==current!.version||input.expectedDocumentVersion!==documentVersion)fail("材料资料或文员确认已更新，请重新读取后核对，未覆盖已有记录");
 if(input.entries.length!==current!.entries.length||input.entries.some(r=>!current!.entries.some(m=>m.materialId===r.materialId)))fail("材料清单已变化，请重新读取当前核料页");
 const now=new Date().toISOString();
 const old=(await db.query("SELECT entries FROM digital_development_material_verifications WHERE source_id=$1 AND round_number=$2 FOR UPDATE",[sourceId,round])).rows[0]?.entries??[];
 const entries=input.entries.map(row=>{
  if(row.usage==="unused"&&(!row.note||!row.confirmedWith))fail("本轮不使用的材料须记录与设计师确认的对象及说明");
  const prior=old.find((r:Stored)=>r.materialId===row.materialId);
  const basis=document.materials.find(m=>m.materialId===row.materialId)!;
  const unchanged=prior&&isDeepStrictEqual({...prior,basis:undefined,changedBy:undefined,changedAt:undefined},{...row,basis:undefined,changedBy:undefined,changedAt:undefined})&&isDeepStrictEqual(prior.basis,basis);
  return {...row,basis,changedBy:unchanged?prior.changedBy:actor.actorId,changedAt:unchanged?prior.changedAt:now};
 });
 await db.query(`INSERT INTO digital_development_material_verifications(source_id,round_number,version,document_version,task_id,entries,changed_by,draft_note,draft_result)
 VALUES($1,$2,1,$3,$4,$5,$6,$7,$8) ON CONFLICT(source_id,round_number) DO UPDATE SET version=digital_development_material_verifications.version+1,document_version=$3,task_id=$4,entries=$5,changed_by=$6,draft_note=$7,draft_result=$8,changed_at=CURRENT_TIMESTAMP`,[sourceId,round,documentVersion,input.taskId,JSON.stringify(entries),actor.actorId,input.note??"",input.result??"通过"]);
 if(await developmentAmendmentsAvailable(db))await db.query("UPDATE digital_development_material_verifications SET draft_return_issues=$3 WHERE source_id=$1 AND round_number=$2",[sourceId,round,JSON.stringify(input.returnIssues??[])]);
 await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,before_state,after_state) VALUES($1,$2,$3,'development_material_verification','digital_development',$4,$5,$6)",[randomUUID(),actor.requestId,actor.actorId,sourceId,JSON.stringify({round,entries:old}),JSON.stringify({round,documentVersion,entries})]);
 return {version:current!.version+1};
}
export async function appliedVerification(db:DB,sourceId:string,round:number,document:DevelopmentDocument){
 if(!await verificationAvailable(db))return null;
 let row=(await db.query("SELECT applied_entries FROM digital_development_material_verifications WHERE source_id=$1 AND round_number=$2",[sourceId,round])).rows[0];
 if(!row?.applied_entries&&round>1){
  row=(await db.query(`SELECT v.applied_entries FROM digital_development_rounds r
   JOIN digital_production_tasks t ON t.task_id=(r.inherited->'development_materials'->>'taskId')::uuid
   JOIN digital_production_task_access a ON a.task_id=t.task_id AND a.source_id=r.source_id
   JOIN digital_development_material_verifications v ON v.source_id=r.source_id AND v.round_number=t.route_version
   WHERE r.source_id=$1 AND r.round_number=$2 AND t.state='completed'`,[sourceId,round])).rows[0];
 }
 return row?.applied_entries?verificationRows(document,row.applied_entries):null;
}
export async function effectiveVerificationDocument(db:DB,sourceId:string,round:number,document:DevelopmentDocument){
 const entries=await appliedVerification(db,sourceId,round,document);
 if(!entries)return document;
 return {...document,materials:document.materials.map(m=>({...m,requiredThisRound:entries.some(e=>e.materialId===m.materialId&&e.usage!=="unused")}))};
}
