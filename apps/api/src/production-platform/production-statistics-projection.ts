import {currentProductionStatistics} from '@dx-rework/domain/production-statistics';
import type {ProductionStatisticsFilters,StatisticsCurrentResult,StatisticsPo,StatisticsPoResult} from '@dx-rework/contracts/production-statistics';

/** Presentation slicing uses only the retained authorized facts and observation.
 * Changing the actual source query filters still requires a new complete result. */
export function productionResultProjection(source:StatisticsCurrentResult,filters:ProductionStatisticsFilters,inputs:StatisticsPo[]){
 const metric=filters.drillMetric??'all',active=(row:StatisticsPoResult)=>row.line.lifecycle!=='cancelled'&&!row.line.specialClosure;
 const matches=(row:StatisticsPoResult)=>{
  if(filters.drillLineId&&row.line.lineId!==filters.drillLineId||filters.drillOrderId&&row.line.orderId!==filters.drillOrderId||filters.drillFactoryId&&!row.line.allocations.some(scope=>scope.current&&scope.quantity>0&&scope.factoryId===filters.drillFactoryId))return false;
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
 const projected=metric==='all'&&!filters.drillLineId&&!filters.drillOrderId&&!filters.drillFactoryId?source:currentProductionStatistics(inputs.filter(row=>ids.has(row.lineId)),source.asOf,source.businessDate);
 if(projected!==source){const externalUnknown=source.unknown.filter(reason=>reason.key==='filter-dimension');if(externalUnknown.length){projected.unknown.push(...externalUnknown);for(const item of Object.values(projected.metrics)){item.value=null;item.unknown.push(...externalUnknown);}}}
 const factoryId=filters.drillFactoryId??filters.factoryId;
 return factoryId?{...projected,factories:projected.factories.filter(factory=>factory.factoryId===factoryId),materials:projected.materials.filter(material=>material.requirement.factoryId===factoryId),workload:projected.workload.filter(item=>item.factoryId===null||item.factoryId===factoryId)}:projected;
}
