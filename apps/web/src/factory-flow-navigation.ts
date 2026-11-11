import type {FactoryFlowSheet} from '@dx-rework/contracts/factory-flow';
import {createWebUrls} from '../url-contract.js';
import {productionWorkspaceDomainHref} from './digital-detail-route.js';
const urls=createWebUrls(import.meta.env.BASE_URL);
/** A known current scope cannot fall back to the original factory after transfer. */
export function factoryFlowProductionHref(sheet:Pick<FactoryFlowSheet,'productionId'|'currentProduction'>,search:string,view:'dashboard'|'reporting'='dashboard',lineId?:string|null):string|null{
 const scope=sheet.currentProduction,id=scope===undefined?sheet.productionId:scope?.productionId;
 if(!id)return null;
 const params=new URLSearchParams();if(scope?.factoryDecisionId)params.set('factoryDecisionId',scope.factoryDecisionId);if(view==='reporting'&&lineId)params.set('line',lineId);
 const target=urls.pageUrl('ui/production-'+view+'/'+id)+(params.size?'?'+params.toString():'');
 return productionWorkspaceDomainHref(target,search);
}
