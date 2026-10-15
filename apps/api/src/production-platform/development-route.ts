import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import type {DigitalTaskKind} from './task-access-repository.js';
import {JOURNEY_NODES} from '@dx-rework/contracts/digital-production-journey';

/** Describe only supplied authorized tasks, using the saved route for this round. */
export function developmentNextSteps(route:readonly string[],tasks:ReadonlyArray<{taskId:string;taskKind:string;routeVersion:number}>,roundNumber:number){
  return tasks.filter(task=>task.routeVersion===roundNumber).flatMap(task=>{
    const materialCheck=['development_materials','development_material_recheck'].includes(task.taskKind);
    const index=route.indexOf(task.taskKind==='development_material_recheck'?'development_materials':task.taskKind);
    let kind=task.taskKind==='development_material_supply'?'development_material_recheck':materialCheck&&index<0&&roundNumber===1?route[0]:index>=0?route[index+1]:undefined;
    if(task.taskKind==='development_craft_confirmation'&&kind==='development_sewing_transfer'&&!tasks.some(t=>t.routeVersion===roundNumber&&t.taskKind==='development_sewing_transfer'))kind='development_sewing';
    const label=JOURNEY_NODES.find(node=>node.key===kind)?.label;
    return label?[{taskId:task.taskId,label}]:[];
  });
}

/** Fixed business route. Craft confirmation and final garment confirmation are distinct. */
export function developmentRoute(document: Pick<DevelopmentDocument,'craft'|'washing'>): DigitalTaskKind[] {
  const route: DigitalTaskKind[]=['development_pattern','development_cutting'];
  if(document.craft!=='无') {
    route.push('development_craft_dispatch');
    route.push(document.craft==='印花'?'development_printing':document.craft==='绣花'?'development_embroidery':'development_print_embroidery');
    route.push('development_craft_confirmation','development_sewing_transfer');
  }
  route.push('development_sewing');
  if(document.washing!=='免洗') route.push('development_washing_dispatch','development_washing');
  route.push('development_tail_check','development_confirmation','development_shipping');
  return route;
}
