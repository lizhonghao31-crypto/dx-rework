import {z} from 'zod';
import {QualityNativeTaskQuerySchema} from '@dx-rework/contracts/production-readiness';
import {createWebUrls} from '../url-contract.js';

const query=QualityNativeTaskQuerySchema.extend({workspace:z.literal('quality'),kind:QualityNativeTaskQuerySchema.shape.kind.default('craft')}).strict();
export type QualityWorkbenchRoute=z.infer<typeof query>;
export function readQualityWorkbenchRoute(parameters:URLSearchParams){
 const keys=[...parameters.keys()];
 if(keys.length!==new Set(keys).size)return null;
 const result=query.safeParse(Object.fromEntries(parameters));
 return result.success?result.data:null;
}
export function qualityWorkbenchPath(value:QualityWorkbenchRoute,base:string){
 return createWebUrls(base).pageUrl('ui/digital-production')+'?'+new URLSearchParams({
  workspace:'quality',kind:value.kind,page:String(value.page),search:value.search,status:value.status,
 });
}
