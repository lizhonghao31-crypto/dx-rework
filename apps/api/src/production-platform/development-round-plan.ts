import type {DevelopmentRevision} from '@dx-rework/contracts/digital-development-rounds';
import type {DigitalTaskKind} from './task-access-repository.js';
import {developmentRoute} from './development-route.js';
import type {PoolClient} from 'pg';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import {isDevelopmentMaterialPlaceholder} from '@dx-rework/contracts/digital-development';
import {isDeepStrictEqual} from 'node:util';
import {verificationAvailable} from './development-material-verification.js';
import {developmentSlaRoute} from './development-sla-enrollment.js';
export function developmentRevisionPlan(input:DevelopmentRevision,completed:Record<string,{taskId:string;roundNumber:number}>,savedRoute?:DigitalTaskKind[]){
 const all:DigitalTaskKind[]=['development_materials',...(savedRoute??developmentRoute(input.document))];
 const selected=new Set<DigitalTaskKind>();
 for(const node of input.affectedNodes){
  if(node==='核配')selected.add('development_materials');
  if(node==='纸样')selected.add('development_pattern');
  if(node==='裁板')selected.add('development_cutting');
  if(node==='工艺')for(const kind of all.filter(kind=>['development_craft_dispatch','development_printing','development_embroidery','development_print_embroidery','development_craft_confirmation'].includes(kind)))selected.add(kind);
  if(node==='车板'){selected.add('development_sewing_transfer');selected.add('development_sewing');}
  if(node==='洗水'){selected.add('development_pre_wash_check');selected.add('development_washing_dispatch');selected.add('development_washing');}
 }
 const applicable=input.outputKind==='工艺布片'?all.filter(kind=>!['development_sewing_transfer','development_sewing','development_pre_wash_check','development_washing_dispatch','development_washing','development_tail_check'].includes(kind)):all;
 if(input.outputKind==='整件样板')selected.add('development_tail_check');
 else for(const kind of applicable.filter(kind=>kind.includes('printing')||kind.includes('embroidery')||kind.includes('craft_')))selected.add(kind);
 selected.add('development_confirmation');selected.add('development_shipping');
 // Missing work is carried forward as real work; only completed facts may be reused.
 for(const kind of applicable)if(!completed[kind])selected.add(kind);
 const route=applicable.filter(kind=>selected.has(kind));
 const inherited=Object.fromEntries(applicable.filter(kind=>!selected.has(kind)&&completed[kind]).map(kind=>[kind,completed[kind]!]));
 return {route,inherited};
}

/** Preview and the native publication share the same selection of real
 * carried-forward work. This reads facts only; new material identities remain
 * the native writer's responsibility. */
export async function readDevelopmentRevisionPlan(db:Pick<PoolClient,'query'>,sourceId:string,input:DevelopmentRevision,previous:DevelopmentDocument,routeSchemaVersion?:number){
 const affectedNodes=[...input.affectedNodes],verified=await verificationAvailable(db);
 for(const material of input.document.materials){const old=previous.materials.find(item=>item.materialId===material.materialId);
  if((!old||!isDeepStrictEqual(old,material))&&(verified?!isDevelopmentMaterialPlaceholder(material):material.requiredThisRound)&&!affectedNodes.includes('核配'))affectedNodes.push('核配');
 }
 if(verified&&previous.materials.some(old=>!isDevelopmentMaterialPlaceholder(old)&&!input.document.materials.some(material=>material.materialId===old.materialId))&&!affectedNodes.includes('核配'))affectedNodes.push('核配');
 const rows=(await db.query(`SELECT t.task_id,t.route_version,a.task_kind FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
  WHERE a.source_id=$1 AND t.state='completed' AND NOT EXISTS(SELECT 1 FROM digital_production_task_events e WHERE e.task_id=t.task_id AND e.event_kind='material_returned')
  ORDER BY t.route_version DESC,t.completed_at DESC,t.task_id`,[sourceId])).rows;
 const completed:Record<string,{taskId:string;roundNumber:number}>={};
 for(const row of rows){const key=row.task_kind==='development_material_recheck'?'development_materials':row.task_kind;if(!completed[key])completed[key]={taskId:row.task_id,roundNumber:row.route_version};}
 let {route,inherited}=developmentRevisionPlan({...input,affectedNodes},completed,routeSchemaVersion?developmentSlaRoute(input.document,input.outputKind,routeSchemaVersion===2?2:1):undefined);
 if(routeSchemaVersion===2){
  const full=['development_materials' as const,...developmentSlaRoute(input.document,input.outputKind,2)],selected=new Set(route),crafts=['development_printing','development_embroidery'] as const,selectedCraft=new Set(crafts.filter(kind=>selected.has(kind)));
  route=full.filter((kind,index)=>kind==='development_craft_dispatch'?selectedCraft.has(full[index+1] as typeof crafts[number]):kind==='development_craft_confirmation'?selectedCraft.has(full[index-1] as typeof crafts[number]):selected.has(kind));
  if(selectedCraft.size){inherited={...inherited};delete inherited.development_craft_dispatch;delete inherited.development_craft_confirmation;}
 }
 return {route,inherited,affectedNodes};
}
