import {currentProductionStatistics} from '@dx-rework/domain/production-statistics';
import type {ProductionGrouping,ProductionStatisticsFilters,ProductionStatisticsGroup,StatisticsCurrentResult,StatisticsMetric,StatisticsPo,StatisticsPoResult} from '@dx-rework/contracts/production-statistics';
import {scopedMotherCompletion} from './production-statistics-projection.js';
import {productionFacetValues,productionFacetMatches} from './production-statistics-dimensions.js';
import {ApplicationError} from '../platform/errors.js';

/** Every group is derived before pagination from the same retained authorized PO
 * facts. Parallel stages and multi-factory PO counts are explicitly non-additive. */
export function productionGroups(result:StatisticsCurrentResult,inputs:StatisticsPo[],motherCompletion:StatisticsMetric,dimensions:ProductionGrouping[],filters:ProductionStatisticsFilters):ProductionStatisticsGroup[]{
 if(!dimensions.length)return [];
 const buckets=new Map<string,{path:ProductionStatisticsGroup['path'];ids:Set<string>}>();
 const fields={factory:'drillFactories',customer:'drillCustomers',stage:'drillStages'} as const;
 const visit=(rows:StatisticsPoResult[],path:ProductionStatisticsGroup['path'],scoped:ProductionStatisticsFilters,depth:number)=>{
  const dimension=dimensions[depth];if(!dimension)return;
  const values=new Map(rows.flatMap(row=>productionFacetValues(row,scoped)[dimension]).map(value=>[value.key,value]));
  for(const value of values.values()){
   const next={...scoped,[fields[dimension]]:[value.key],...(dimension==='stage'?{drillStageFactories:scoped.drillStageFactories??scoped.drillFactories??(scoped.drillFactoryId?[scoped.drillFactoryId]:[])}:{})},selected=rows.filter(row=>productionFacetMatches(row,next));if(!selected.length)continue;
   const prefix=[...path,{dimension,...value}],key=JSON.stringify(prefix.map(value=>[value.dimension,value.key]));buckets.set(key,{path:prefix,ids:new Set(selected.map(row=>row.line.lineId))});if(buckets.size>1000)throw new ApplicationError('ANALYSIS_GROUP_RANGE_TOO_LARGE','分组超过本次可显示范围，请减少分组层次或缩小筛选',409);
   visit(selected,prefix,next,depth+1);
  }
 };
 visit(result.rows,[],filters,0);
 return [...buckets.values()].map(({path,ids})=>{
  const group=currentProductionStatistics(inputs.filter(row=>ids.has(row.lineId)),result.asOf,result.businessDate);group.metrics.completedOrders=scopedMotherCompletion(motherCompletion,group.rows);
  const external=result.unknown.filter(reason=>reason.key==='filter-dimension'&&(reason.lineId===null||ids.has(reason.lineId)));if(external.length){group.unknown.push(...external);for(const metric of Object.values(group.metrics)){metric.value=null;metric.unknown.push(...external);}}
  const factoryKey=path.find(value=>value.dimension==='factory')?.key,factory=factoryKey&&factoryKey!=='unknown'?group.factories.find(value=>value.factoryId===factoryKey)??null:null;
  return {path,lineIds:[...ids].sort(),metrics:group.metrics,factory,nonAdditive:true as const,unknown:group.unknown};
 }).sort((a,b)=>{for(let index=0;index<Math.min(a.path.length,b.path.length);index++){const order=a.path[index]!.label.localeCompare(b.path[index]!.label,'zh-CN');if(order)return order;}return a.path.length-b.path.length;});
}
