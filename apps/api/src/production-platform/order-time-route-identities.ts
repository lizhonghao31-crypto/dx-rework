import {createHash} from 'node:crypto';
import type {CraftStepChoice} from '@dx-rework/contracts/digital-craft';
import type {OrderTimeInput} from './order-time-plan-repository.js';

type Step=CraftStepChoice&{stepId:string};
/** A reserved work identity is not a readiness/completion event. Allocate it
 * from this real order and saved instruction version, then let the original
 * preparation command bind that exact identity to its native route. */
export function orderTimeBulkSteps(orderId:string,version:number,choices:readonly CraftStepChoice[],previous:readonly Step[]):Step[]{
 if(choices.length===previous.length&&choices.every((step,index)=>step.craftKind===previous[index]?.craftKind&&step.sequence===previous[index]?.sequence))return structuredClone([...previous]);
 return choices.map(step=>{const hex=createHash('sha256').update(JSON.stringify(['order-time-bulk-v1',orderId,version,step.craftKind,step.sequence])).digest('hex');
  const stepId=`${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;return {...step,stepId};});
}
export function orderTimeStoredBulkSteps(value:OrderTimeInput|null|undefined):Step[]{
 return (value?.work??[]).flatMap(work=>{const kind=work.parameterKey==='bulk_printing'?'printing':work.parameterKey==='bulk_embroidery'?'embroidery':null,step=work.canonicalWorkRef?.match(/:step:([0-9a-f-]{36}):work$/)?.[1];return kind&&step?[{craftKind:kind as Step['craftKind'],sequence:0,stepId:step}]:[];}).map((step,index)=>({...step,sequence:index+1}));
}
