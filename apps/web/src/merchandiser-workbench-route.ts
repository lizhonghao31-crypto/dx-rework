import {MerchandiserWorkQuerySchema} from '@dx-rework/contracts';
import {z} from 'zod';
import {createWebUrls} from '../url-contract.js';

const schema=MerchandiserWorkQuerySchema.extend({workspace:z.literal('merchandiser')}).strict();
export type MerchandiserWorkbenchRoute=z.infer<typeof schema>;
export function readMerchandiserWorkbenchRoute(query:URLSearchParams){
 const keys=[...query.keys()];
 if(keys.length!==new Set(keys).size)return null;
 const parsed=schema.safeParse(Object.fromEntries(query));
 return parsed.success?parsed.data:null;
}
export function merchandiserWorkbenchPath(value:MerchandiserWorkbenchRoute,base:string){
 const params=new URLSearchParams({workspace:value.workspace,page:String(value.page),search:value.search});
 if(value.kind)params.set('kind',value.kind);
 return createWebUrls(base).pageUrl('ui/digital-production')+'?'+params;
}
