import {digitalDetailReturnUrl} from './digital-detail-route.js';
import {z} from 'zod';
import {ProductionDashboardQuerySchema} from '@dx-rework/contracts';
import {createWebUrls} from '../url-contract.js';
const schema=ProductionDashboardQuerySchema.extend({workspace:z.literal('display'),selected:z.string().uuid().optional(),factoryDecisionId:z.string().uuid().optional()});
/** Consume only the local display workspace and validated, unique query fields. */
export function productionDisplayReturnUrl(value:string|null):string|null{
 if(!value||!value.startsWith('/')||value.startsWith('//')||value.includes('\\'))return null;
 try{const url=new URL(value,'https://local.invalid');if(url.pathname!==createWebUrls(import.meta.env.BASE_URL).pageUrl('ui/production-dashboard')||url.hash||[...url.searchParams.keys()].length!==new Set(url.searchParams.keys()).size||!schema.safeParse(Object.fromEntries(url.searchParams)).success)return null;return url.pathname+url.search;}catch{return null;}
}
export function productionDisplayDomainHref(url:string,search:string){const returnTo=productionDisplayReturnUrl(new URLSearchParams(search).get('returnTo'));if(!returnTo)return url;const parsed=new URL(url,'https://local.invalid');parsed.searchParams.set('returnTo',returnTo);return parsed.pathname+parsed.search;}

/** Existing reporting route, exact order/factory and validated return context. */
export function productionReportingHref(orderId:string|null,factoryDecisionId:string|null,returnTo:string|null):string|null{
 if(orderId&&!z.uuid().safeParse(orderId).success||factoryDecisionId&&!z.uuid().safeParse(factoryDecisionId).success)return null;
 const target=createWebUrls(import.meta.env.BASE_URL).pageUrl('ui/production-reporting'+(orderId?'/'+orderId:'')),params=new URLSearchParams();
 if(orderId&&factoryDecisionId)params.set('factoryDecisionId',factoryDecisionId);
 const context=productionDisplayReturnUrl(returnTo)??digitalDetailReturnUrl(returnTo,import.meta.env.BASE_URL);if(context)params.set('returnTo',context);
 return target+(params.size?'?'+params:'');
}
