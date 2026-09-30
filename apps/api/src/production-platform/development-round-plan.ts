import type {DevelopmentRevision} from '@dx-rework/contracts/digital-development-rounds';
import type {DigitalTaskKind} from './task-access-repository.js';
import {developmentRoute} from './development-route.js';
export function developmentRevisionPlan(input:DevelopmentRevision,completed:Record<string,{taskId:string;roundNumber:number}>){
 const all:DigitalTaskKind[]=['development_materials',...developmentRoute(input.document)];
 const selected=new Set<DigitalTaskKind>();
 for(const node of input.affectedNodes){
  if(node==='核配')selected.add('development_materials');
  if(node==='纸样')selected.add('development_pattern');
  if(node==='裁板')selected.add('development_cutting');
  if(node==='工艺')for(const kind of all.filter(kind=>['development_craft_dispatch','development_printing','development_embroidery','development_print_embroidery','development_craft_confirmation'].includes(kind)))selected.add(kind);
  if(node==='车板'){selected.add('development_sewing_transfer');selected.add('development_sewing');}
  if(node==='洗水'){selected.add('development_washing_dispatch');selected.add('development_washing');}
 }
 const applicable=input.outputKind==='工艺布片'?all.filter(kind=>!['development_sewing_transfer','development_sewing','development_washing_dispatch','development_washing','development_tail_check'].includes(kind)):all;
 if(input.outputKind==='整件样板')selected.add('development_tail_check');
 else for(const kind of applicable.filter(kind=>kind.includes('printing')||kind.includes('embroidery')||kind.includes('craft_')))selected.add(kind);
 selected.add('development_confirmation');selected.add('development_shipping');
 // Missing work is carried forward as real work; only completed facts may be reused.
 for(const kind of applicable)if(!completed[kind])selected.add(kind);
 const route=applicable.filter(kind=>selected.has(kind));
 const inherited=Object.fromEntries(applicable.filter(kind=>!selected.has(kind)&&completed[kind]).map(kind=>[kind,completed[kind]!]));
 return {route,inherited};
}
