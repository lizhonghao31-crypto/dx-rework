import {currentProductionStatistics} from '@dx-rework/domain/production-statistics';
import type {ProductionStatisticsFilters,StatisticsCurrentResult,StatisticsMetric,StatisticsPo,StatisticsPoResult} from '@dx-rework/contracts/production-statistics';
import {productionFacetMatches,productionFactorySelected} from './production-statistics-dimensions.js';

/** Mother completion is assessed over all its applicable POs, even when only one
 * of them belongs to the displayed subset. Incomplete siblings cannot disappear. */
export function scopedMotherCompletion(assessment:StatisticsMetric,rows:StatisticsPoResult[]):StatisticsMetric{
 const orders=new Set(rows.map(row=>row.line.orderId)),knownIds=assessment.knownIds.filter(id=>orders.has(id)),unknown=assessment.unknown.filter(reason=>orders.has(reason.orderId));
 return {...assessment,value:unknown.length?null:knownIds.length,knownValue:knownIds.length,knownIds,unknown,excludedIds:assessment.excludedIds.filter(id=>orders.has(id))};
}

/** Presentation slicing uses only the retained authorized facts and observation.
 * Changing the actual source query filters still requires a new complete result. */
export function productionResultProjection(source:StatisticsCurrentResult,filters:ProductionStatisticsFilters,inputs:StatisticsPo[],motherCompletion:StatisticsMetric=source.metrics.completedOrders){
 const metric=filters.drillMetric??'all',active=(row:StatisticsPoResult)=>row.line.lifecycle!=='cancelled'&&!row.line.specialClosure;
 const matches=(row:StatisticsPoResult)=>{
  if(filters.drillLineId&&row.line.lineId!==filters.drillLineId||filters.drillOrderId&&row.line.orderId!==filters.drillOrderId||filters.drillFactoryId&&!row.line.allocations.some(scope=>scope.current&&scope.quantity>0&&scope.factoryId===filters.drillFactoryId))return false;
  if(!productionFacetMatches(row,filters))return false;
  switch(metric){
   case 'backlog':return active(row)&&row.remaining!==0;
   case 'next-seven':return active(row)&&row.remaining!==0&&row.line.customerDate!==null&&row.line.customerDate>=source.sevenDayWindow.fromInclusive&&row.line.customerDate<source.sevenDayWindow.toExclusive;
   case 'past-due':return active(row)&&row.remaining!==0&&row.line.customerDate!==null&&row.line.customerDate<source.businessDate;
   case 'blocked':return row.line.problems.some(problem=>problem.blocking&&problem.state==='current'&&(!problem.lineIds.length||problem.lineIds.includes(row.line.lineId)));
   case 'quality-gap':return row.qualityMissing!==null&&row.qualityMissing>0;
   case 'unknown':return row.unknown.length>0||source.unknown.some(reason=>reason.orderId===row.line.orderId&&(reason.lineId===null||reason.lineId===row.line.lineId))||source.materials.some(material=>material.state==='unknown'&&row.line.materials.some(requirement=>requirement.requirementId===material.requirement.requirementId));
   case 'unallocated':return active(row)&&row.unallocated!==0;
   case 'completed':return active(row)&&row.quantityComplete===true;
   case 'cancelled':return row.line.lifecycle==='cancelled';
   case 'special':return row.line.specialClosure;
   default:return true;
  }
 };
 const ids=new Set(source.rows.filter(matches).map(row=>row.line.lineId));
 // A displayed row has already collapsed duplicate versions. Retain the original
 // authorized inputs so a slice cannot turn a proven contradiction into certainty.
 const projected=metric==='all'&&!filters.drillLineId&&!filters.drillOrderId&&!filters.drillFactoryId&&!filters.drillFactories&&!filters.drillCustomers&&!filters.drillStages?source:currentProductionStatistics(inputs.filter(row=>ids.has(row.lineId)),source.asOf,source.businessDate);
 if(projected!==source)projected.metrics.completedOrders=scopedMotherCompletion(motherCompletion,projected.rows);
 if(projected!==source){const externalUnknown=source.unknown.filter(reason=>reason.key==='filter-dimension');if(externalUnknown.length){projected.unknown.push(...externalUnknown);for(const item of Object.values(projected.metrics)){item.value=null;item.unknown.push(...externalUnknown);}}}
 const constrained=Boolean(filters.drillFactoryId||filters.factoryId||filters.drillFactories);
 return constrained?{...projected,factories:projected.factories.filter(factory=>productionFactorySelected(factory.factoryId,filters)),materials:projected.materials.filter(material=>productionFactorySelected(material.requirement.factoryId,filters)),workload:projected.workload.filter(item=>item.factoryId===null||productionFactorySelected(item.factoryId,filters))}:projected;
}
