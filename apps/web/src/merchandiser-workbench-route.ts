import {MerchandiserWorkQuerySchema} from '@dx-rework/contracts';
import {z} from 'zod';
import {createWebUrls} from '../url-contract.js';

const schema=MerchandiserWorkQuerySchema.extend({workspace:z.literal('merchandiser'),view:z.enum(['work','orders']).default('work'),
 focus:z.uuid().optional(),documentOrder:z.uuid().optional()}).strict().refine(value=>!value.documentOrder||value.view==='orders');
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
 if(value.state!=='mine')params.set('state',value.state);
 if(value.view==='orders')params.set('view','orders');
 if(value.focus)params.set('focus',value.focus);
 if(value.documentOrder)params.set('documentOrder',value.documentOrder);
 return createWebUrls(base).pageUrl('ui/digital-production')+'?'+params;
}
