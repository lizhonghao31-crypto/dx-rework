import {z} from 'zod';
import {QualityNativeTaskQuerySchema} from '@dx-rework/contracts/production-readiness';
import {createWebUrls} from '../url-contract.js';

const query=QualityNativeTaskQuerySchema.extend({workspace:z.literal('quality'),kind:z.enum(['craft','factory','garment']).default('craft')}).strict();
export type QualityWorkbenchRoute=z.infer<typeof query>;
export function readQualityWorkbenchRoute(parameters:URLSearchParams){
 const keys=[...parameters.keys()];
 if(keys.length!==new Set(keys).size)return null;
 const result=query.safeParse(Object.fromEntries(parameters));
 return result.success?result.data:null;
}
/** Only a complete typed source may open an exact current check. Old links
 * without a quality scope keep their original professional page. */
export function qualityRecordTarget(parameters:URLSearchParams){
 const fields=['qualityProduction','qualityDecision','qualityReceipt','qualityQuantityVersion','qualityReturn','qualityStep','qualityTask'];
 if(!fields.some(key=>parameters.has(key)))return undefined;
 if(fields.some(key=>parameters.getAll(key).length>1))return null;
 const id=z.uuid();
 const receipt=parameters.get('qualityReceipt'),version=parameters.get('qualityQuantityVersion');
 const production=parameters.get('qualityProduction'),decision=parameters.get('qualityDecision'),line=parameters.get('line');
 const returnFact=parameters.get('qualityReturn'),step=parameters.get('qualityStep'),task=parameters.get('qualityTask');
 if(!returnFact&&!step&&!task&&!receipt&&!version&&parameters.getAll('factory').length===1&&parameters.get('factoryAction')==='productionQc'&&parameters.getAll('line').length===1&&
     id.safeParse(production).success&&(decision==='original'||id.safeParse(decision).success)&&id.safeParse(line).success){
  return {kind:'factory' as const,productionId:production!,factoryDecisionId:decision==='original'?null:decision!,lineId:line!};
 }
 if(!returnFact&&!step&&!task&&!production&&!decision&&!line&&parameters.getAll('closure').length===1&&id.safeParse(receipt).success&&id.safeParse(version).success){
  return {kind:'garment' as const,receiptId:receipt!,quantityVersion:version!};
 }
 if(!receipt&&!version&&!production&&!decision&&parameters.getAll('factory').length===1&&parameters.get('factoryAction')==='qc'&&parameters.getAll('line').length===1&&
    id.safeParse(returnFact).success&&(step==='original'||id.safeParse(step).success)&&id.safeParse(task).success&&id.safeParse(line).success){
  return {kind:'craft' as const,returnFactId:returnFact!,stepRef:step==='original'?null:step!,taskId:task!,lineId:line!};
 }
 return null;
}
export function qualityWorkbenchPath(value:QualityWorkbenchRoute,base:string){
 return createWebUrls(base).pageUrl('ui/digital-production')+'?'+new URLSearchParams({
  workspace:'quality',kind:value.kind,page:String(value.page),search:value.search,status:value.status,
 });
}
