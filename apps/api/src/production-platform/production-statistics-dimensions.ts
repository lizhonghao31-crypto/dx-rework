import type {ProductionGrouping,ProductionStatisticsFilters,StatisticsCurrentResult,StatisticsPoResult} from '@dx-rework/contracts/production-statistics';

type Facet={key:string;label:string};
type FacetFilters=Pick<ProductionStatisticsFilters,'factoryId'|'drillFactoryId'|'drillFactories'|'drillCustomers'|'drillStages'|'drillStageFactories'>;
export function productionRowFacets(row:StatisticsPoResult,factory?:string):Record<ProductionGrouping,Facet[]>{
 const current=row.line.allocations.filter(item=>item.current&&item.quantity>0),factories=[...new Map(current.map(item=>[item.factoryId,{key:item.factoryId,label:item.factoryName}])).values()];
 if(!factories.length||row.unallocated!==0){const inactive=row.line.lifecycle==='cancelled'||row.line.specialClosure;factories.push(inactive||row.unallocated===0?{key:'none',label:'无当前有效工厂份额'}:row.unallocated===null?{key:'unknown',label:'归厂或覆盖范围待核'}:{key:'uncovered',label:'尚未覆盖选厂的范围'});}
 const workload=(row.line.workload??[]).filter(item=>item.active&&(!item.lineIds.length||item.lineIds.includes(row.line.lineId))&&(!factory||item.factoryId===null||item.factoryId===factory));
 const stages=[...new Map(workload.map(item=>[item.nodeKey,{key:item.nodeKey,label:item.label+(item.factoryId===null?'（整单/PO节点）':'')}])).values()];
 return {factory:factories,customer:[{key:row.line.customerCode,label:row.line.customerCode}],stage:stages.length?stages:[{key:'__none',label:'当前活动节点未核到'}]};
}

export function productionFactorySelected(key:string|null,filters:FacetFilters){
 if(filters.factoryId&&key!==filters.factoryId||filters.drillFactoryId&&key!==filters.drillFactoryId)return false;
 return !filters.drillFactories||(key===null?filters.drillFactories.some(value=>['unknown','uncovered','none'].includes(value)):filters.drillFactories.includes(key));
}

/** Both group prefixes and their drill links use this exact factory context.
 * Without a selected factory, stages are PO-wide rather than synthetic per-factory empties. */
export function productionFacetValues(row:StatisticsPoResult,filters:FacetFilters):Record<ProductionGrouping,Facet[]>{
 const values=productionRowFacets(row),factory=values.factory.filter(value=>productionFactorySelected(value.key,filters)),scoped=Boolean(filters.factoryId||filters.drillFactoryId||filters.drillFactories);
 const stages=scoped?factory.flatMap(value=>productionRowFacets(row,value.key).stage):values.stage;
 // Retain the stage prefix's scope when a later factory dimension narrows it.
 // Also require a matching node in the selected factory (parallel siblings do not match).
 const stageScope=filters.drillStageFactories,scopeStages=stageScope===undefined?null:stageScope.length?values.factory.filter(value=>productionFactorySelected(value.key,{...(filters.factoryId?{factoryId:filters.factoryId}:{}),drillFactories:stageScope})).flatMap(value=>productionRowFacets(row,value.key).stage):productionRowFacets(row,filters.factoryId).stage;
 const allowed=new Set(scopeStages?.map(value=>value.key));
 return {factory,customer:values.customer.filter(value=>!filters.drillCustomers||filters.drillCustomers.includes(value.key)),stage:[...new Map(stages.filter(value=>(!filters.drillStages||filters.drillStages.includes(value.key))&&(!scopeStages||allowed.has(value.key))).map(value=>[value.key,value])).values()]};
}
export function productionFacetMatches(row:StatisticsPoResult,filters:FacetFilters){
 const values=productionFacetValues(row,filters);return values.factory.length>0&&values.customer.length>0&&values.stage.length>0;
}

export function productionFacets(result:StatisticsCurrentResult,factoryId?:string){
 const facets:Record<ProductionGrouping,Map<string,Facet>>={factory:new Map(),customer:new Map(),stage:new Map()};
 for(const row of result.rows){const values=productionFacetValues(row,factoryId?{factoryId}:{});for(const dimension of ['factory','customer','stage'] as const)for(const value of values[dimension])facets[dimension].set(value.key,value);}
 return Object.fromEntries(Object.entries(facets).map(([key,values])=>[key,[...values.values()].sort((a,b)=>a.label.localeCompare(b.label,'zh-CN'))])) as Record<ProductionGrouping,Facet[]>;
}
