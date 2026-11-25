import {z} from 'zod';
import {createWebUrls} from '../url-contract.js';

const values=z.object({workspace:z.literal('warehouse'),tab:z.enum(['receive','preshrink','dispatch']).default('receive'),
 page:z.coerce.number().int().min(1).max(100000).default(1),search:z.string().trim().max(100).default(''),
 status:z.enum(['open','completed']).default('open')}).strict();
export type WarehouseWorkbenchRoute=z.infer<typeof values>;
export function readWarehouseWorkbenchRoute(query:URLSearchParams){
 const keys=[...query.keys()];
 if(keys.length!==new Set(keys).size)return null;
 const result=values.safeParse(Object.fromEntries(query));
 return result.success?result.data:null;
}
export function warehouseWorkbenchPath(route:WarehouseWorkbenchRoute,base:string){
 const url=createWebUrls(base).pageUrl('ui/digital-production');
 return url+'?'+new URLSearchParams({workspace:'warehouse',tab:route.tab,page:String(route.page),search:route.search,status:route.status});
}
export function warehouseWorkbenchReturnTab(path:string|null,base:string){
 if(!path)return null;
 const local=new URL(path,'https://workbench.invalid');
 if(local.origin!=='https://workbench.invalid'||local.pathname!==createWebUrls(base).pageUrl('ui/digital-production'))return null;
 return readWarehouseWorkbenchRoute(local.searchParams)?.tab??null;
}
