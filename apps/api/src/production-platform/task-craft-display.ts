import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
type CraftKind='printing'|'embroidery'|'special';
const phases:Record<string,string>={development_craft_dispatch:'发',development_craft_confirmation:'回样确认',process_logistics:'物流',bulk_qc:'回仓检查'};
/** The metadata is the task's captured immutable step, never the current
 * company library or the last task sharing its technical kind. */
export function taskCraftDisplay(kind:string,fallback:string,basis:unknown,step?:{kind?:string|null;name?:string|null;sequence?:number|null;count?:number|null}):Pick<DigitalTask,'label'|'stepRef'|'craftKind'|'craftSequence'>{
 if(!['development_craft_dispatch','development_printing','development_embroidery','development_print_embroidery','development_craft_confirmation','process_logistics','bulk_qc'].includes(kind))return {label:fallback};
 const b=basis&&typeof basis==='object'?basis as {basis?:unknown}:null,refs=Array.isArray(b?.basis)?b.basis.filter((value):value is string=>typeof value==='string'):[];
 const ids=[...new Set(refs.filter(ref=>ref.startsWith('craft-step:')).map(ref=>ref.slice(11)))],crafts=[...new Set(refs.filter(ref=>ref.startsWith('craft-kind:')).map(ref=>ref.slice(11)))];
 if(!ids.length)return {label:fallback};if(ids.length!==1||!ids[0])return {label:'工艺（实例待核）'};
 const selected=step?.kind??(crafts.length===1?crafts[0]:null);if(!selected||!['printing','embroidery','special'].includes(selected))return {stepRef:ids[0]!,label:'工艺（类别待核）'};
 const craftKind=selected as CraftKind,name=craftKind==='printing'?'印花':craftKind==='embroidery'?'绣花':step?.name?.trim()||'特殊工艺';
 const phase=phases[kind],base=kind==='development_craft_dispatch'?`发${name}`:kind==='development_craft_confirmation'?`${name}回样确认`:phase?`${name}${phase}`:name;
 const sequence=step?.sequence&&Number.isSafeInteger(Number(step.sequence))&&Number(step.sequence)>0?Number(step.sequence):undefined;
 return {stepRef:ids[0]!,craftKind,...(sequence?{craftSequence:sequence}:{}),label:sequence&&Number(step?.count)>1?`${base}（工艺${sequence}）`:base};
}
