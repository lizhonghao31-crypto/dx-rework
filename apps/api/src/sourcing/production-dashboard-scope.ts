import type {ProductionDashboardScope} from '@dx-rework/contracts';
import type {PoolClient} from 'pg';
import {DigitalProductionAccessPolicy} from '../production-platform/access-policy.js';
import {readCockpitFactoryScopes} from '../production-platform/cockpit-home-facts.js';
import {readJourneyCandidateVisibility} from '../production-platform/journey-search-metadata.js';
import {wholeOrderActiveSql} from '../production-platform/whole-order-visibility.js';
import {ApplicationError} from '../platform/errors.js';
import type {TrustedActorContext} from '../tools/repositories.js';

/** Use the same original mother access and positive allocated PO scope as the cockpit. */
export async function readProductionDashboardScope(
 client:PoolClient,actor:TrustedActorContext,motherOrderId:string,asOf:string,
):Promise<ProductionDashboardScope>{
 const {rows:[mother]}=await client.query<{production_order_id:string;created_by:string;primary_merchandiser_id:string|null}>(
  `SELECT o.production_order_id,o.created_by,o.primary_merchandiser_id FROM digital_production_orders o
   WHERE o.production_order_id=$1 AND ${await wholeOrderActiveSql(client,'order','o.production_order_id')}`,[motherOrderId]);
 if(!mother||!(await readJourneyCandidateVisibility(new DigitalProductionAccessPolicy(client),actor,{source:null,order:mother})).fullOrder)
  throw new ApplicationError('NOT_FOUND','找不到可查看生产进度的母单',404);
 const allocations=(await readCockpitFactoryScopes(client,actor,[{id:motherOrderId,asOf}])).get(motherOrderId)??[];
 const factories=new Map<string,ProductionDashboardScope['factories'][number]>();
 for(const factory of allocations){
  if(!factory.visible)continue;
  factories.set(factory.productionId+':'+(factory.factoryDecisionId??''),{
   productionOrderId:factory.productionId,factoryDecisionId:factory.factoryDecisionId,
   factoryName:factory.factoryName,detailAvailable:factory.status!==null,
  });
 }
 return {motherOrderId,factories:[...factories.values()].sort((a,b)=>
  a.factoryName.localeCompare(b.factoryName)||a.productionOrderId.localeCompare(b.productionOrderId)
  ||(a.factoryDecisionId??'').localeCompare(b.factoryDecisionId??''))};
}
