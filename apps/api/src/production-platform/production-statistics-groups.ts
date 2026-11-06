import {currentProductionStatistics} from '@dx-rework/domain/production-statistics';
import type {ProductionGrouping,ProductionStatisticsFilters,ProductionStatisticsGroup,StatisticsCurrentResult,StatisticsMetric,StatisticsPo} from '@dx-rework/contracts/production-statistics';
import {scopedMotherCompletion} from './production-statistics-projection.js';
import {productionRowFacets} from './production-statistics-dimensions.js';
import {ApplicationError} from '../platform/errors.js';

/** Every group is derived before pagination from the same retained authorized PO
 * facts. Parallel stages and multi-factory PO counts are explicitly non-additive. */
export function productionGroups(result:StatisticsCurrentResult,inputs:StatisticsPo[],motherCompletion:StatisticsMetric,dimensions:ProductionGrouping[],filters:ProductionStatisticsFilters):ProductionStatisticsGroup[]{
 if(!dimensions.length)return [];
 const buckets=new Map<string,{path:ProductionStatisticsGroup['path'];ids:Set<string>}>();
 for(const row of result.rows){
  const facets=productionRowFacets(row);
  const selectedFactories=filters.drillFactories??(filters.drillFactoryId?[filters.drillFactoryId]:filters.factoryId?[filters.factoryId]:undefined);
  for(const factory of facets.factory.filter(value=>!selectedFactories||selectedFactories.includes(value.key)))for(const customer of facets.customer)for(const stage of productionRowFacets(row,factory.key).stage.filter(value=>!filters.drillStages||filters.drillStages.includes(value.key))){
   const values={factory,customer,stage},path=dimensions.map(dimension=>({dimension,...values[dimension]}));
   for(let depth=1;depth<=path.length;depth++){
    const prefix=path.slice(0,depth),key=JSON.stringify(prefix.map(value=>[value.dimension,value.key])),bucket=buckets.get(key)??{path:prefix,ids:new Set<string>()};bucket.ids.add(row.line.lineId);buckets.set(key,bucket);if(buckets.size>1000)throw new ApplicationError('ANALYSIS_GROUP_RANGE_TOO_LARGE','分组超过本次可显示范围，请减少分组层次或缩小筛选',409);
   }
  }
 }
 return [...buckets.values()].map(({path,ids})=>{
  const group=currentProductionStatistics(inputs.filter(row=>ids.has(row.lineId)),result.asOf,result.businessDate);group.metrics.completedOrders=scopedMotherCompletion(motherCompletion,group.rows);
  const external=result.unknown.filter(reason=>reason.key==='filter-dimension'&&(reason.lineId===null||ids.has(reason.lineId)));if(external.length){group.unknown.push(...external);for(const metric of Object.values(group.metrics)){metric.value=null;metric.unknown.push(...external);}}
  const factoryKey=path.find(value=>value.dimension==='factory')?.key,factory=factoryKey&&factoryKey!=='unknown'?group.factories.find(value=>value.factoryId===factoryKey)??null:null;
  return {path,lineIds:[...ids].sort(),metrics:group.metrics,factory,nonAdditive:true as const,unknown:group.unknown};
 }).sort((a,b)=>{for(let index=0;index<Math.min(a.path.length,b.path.length);index++){const order=a.path[index]!.label.localeCompare(b.path[index]!.label,'zh-CN');if(order)return order;}return a.path.length-b.path.length;});
}
