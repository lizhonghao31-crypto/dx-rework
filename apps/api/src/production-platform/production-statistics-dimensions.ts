import type {ProductionGrouping,StatisticsCurrentResult,StatisticsPoResult} from '@dx-rework/contracts/production-statistics';

type Facet={key:string;label:string};
export function productionRowFacets(row:StatisticsPoResult,factory?:string):Record<ProductionGrouping,Facet[]>{
 const current=row.line.allocations.filter(item=>item.current&&item.quantity>0),factories=[...new Map(current.map(item=>[item.factoryId,{key:item.factoryId,label:item.factoryName}])).values()];
 if(!factories.length||row.unallocated!==0){const inactive=row.line.lifecycle==='cancelled'||row.line.specialClosure;factories.push(inactive||row.unallocated===0?{key:'none',label:'无当前有效工厂份额'}:row.unallocated===null?{key:'unknown',label:'归厂或覆盖范围待核'}:{key:'uncovered',label:'尚未覆盖选厂的范围'});}
 const workload=(row.line.workload??[]).filter(item=>item.active&&(!item.lineIds.length||item.lineIds.includes(row.line.lineId))&&(!factory||item.factoryId===null||item.factoryId===factory));
 const stages=[...new Map(workload.map(item=>[item.nodeKey,{key:item.nodeKey,label:item.label+(item.factoryId===null?'（整单/PO节点）':'')}])).values()];
 return {factory:factories,customer:[{key:row.line.customerCode,label:row.line.customerCode}],stage:stages.length?stages:[{key:'__none',label:'当前活动节点未核到'}]};
}

export function productionFacets(result:StatisticsCurrentResult){
 const facets:Record<ProductionGrouping,Map<string,Facet>>={factory:new Map(),customer:new Map(),stage:new Map()};
 for(const row of result.rows){const values=productionRowFacets(row);for(const dimension of ['factory','customer','stage'] as const)for(const value of values[dimension])facets[dimension].set(value.key,value);}
 return Object.fromEntries(Object.entries(facets).map(([key,values])=>[key,[...values.values()].sort((a,b)=>a.label.localeCompare(b.label,'zh-CN'))])) as Record<ProductionGrouping,Facet[]>;
}

