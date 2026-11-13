import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {craftStepIdentity,type CraftStepChoice} from '@dx-rework/contracts/digital-craft';
import type {OrderTimeInput} from './order-time-plan-repository.js';

type Step=CraftStepChoice&{stepId:string};
/** A reserved work identity is not a readiness/completion event. Allocate it
 * from this real order and saved instruction version, then let the original
 * preparation command bind that exact identity to its native route. */
export function orderTimeBulkSteps(orderId:string,version:number,choices:readonly CraftStepChoice[],previous:readonly Step[]):Step[]{
 if(choices.length===previous.length&&choices.every((step,index)=>craftStepIdentity(step)===craftStepIdentity(previous[index]!)&&step.sequence===previous[index]?.sequence&&isDeepStrictEqual(step.specialCraft,previous[index]?.specialCraft)))return structuredClone([...previous]);
 return choices.map(step=>{const hex=createHash('sha256').update(JSON.stringify(['order-time-bulk-v1',orderId,version,craftStepIdentity(step),step.sequence])).digest('hex');
  const stepId=`${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;return {...step,stepId};});
}
export function orderTimeStoredBulkSteps(value:OrderTimeInput|null|undefined):Step[]{
 return (value?.work??[]).flatMap(work=>{const kind=work.parameterKey==='bulk_printing'?'printing':work.parameterKey==='bulk_embroidery'?'embroidery':null,step=work.canonicalWorkRef?.match(/:step:([0-9a-f-]{36}):work$/)?.[1];return step&&work.parameterKey.startsWith('bulk_special_')&&work.craftStep?.craftKind==='special'?[{...work.craftStep,stepId:step}]:kind&&step?[{craftKind:kind as Step['craftKind'],sequence:0,stepId:step}]:[];}).map((step,index)=>({...step,sequence:index+1}));
}
