import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import type {DigitalTaskKind} from './task-access-repository.js';

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
export function missingSewingMaterials(document: DevelopmentDocument, events: ReadonlyArray<{materialId:string;action:string}>): string[] {
  return document.materials.filter(material=>material.requiredThisRound&&!material.available
    && !events.some(event=>event.materialId===material.materialId&&(event.action==='到货'||(material.category==='辅料'&&event.action==='确认代用'))))
    .map(material=>material.label||material.name||'未命名物料');
}
/** The original material-supply resubmission gate: auxiliaries are not main/contrast cloth. */
export function missingMainMaterials(document: DevelopmentDocument, events: ReadonlyArray<{materialId:string;action:string}>): string[] {
  return document.materials.filter(material=>material.requiredThisRound&&material.category!=='辅料'&&!material.available
    &&!events.some(event=>event.materialId===material.materialId&&event.action==='到货'))
    .map(material=>material.label||material.name||'未命名物料');
}
