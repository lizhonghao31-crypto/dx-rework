import {z} from 'zod';
import {DigitalAnalysisFilterSchema} from '@dx-rework/contracts/digital-production-analysis';
import type {ProductionStatisticsFilters,StatisticsMetric,StatisticsCurrentResult,ProductionStatisticsGroup} from '@dx-rework/contracts/production-statistics';

export const productionMetricLabels={all:'全部有权范围',backlog:'当前在产未装齐','next-seven':'未来七日应出货未齐','past-due':'已过客户交期未齐',blocked:'原明确阻断涉及范围','quality-gap':'到仓检查覆盖缺口',unknown:'具体缺件范围',unallocated:'选厂未覆盖或范围待核',completed:'普通数量已完成',cancelled:'已取消',special:'特殊结案'} as const;
export const productionColumns=[['po','PO / 颜色'],['customer','客户'],['demand','需求'],['received','有效实收'],['quality','到仓检查覆盖'],['packed','装箱出货'],['remaining','客户待出货'],['customerDate','客户约定'],['unallocated','选厂未覆盖'],['materials','发料状态']] as const;
export type ProductionColumn=typeof productionColumns[number][0];
export const productionGroupings=[['factory','工厂'],['customer','客户'],['stage','当前节点']] as const;
export type ProductionGrouping=typeof productionGroupings[number][0];
const preferencesSchema=z.object({version:z.literal(1),columns:z.array(z.enum(productionColumns.map(([key])=>key) as [ProductionColumn,...ProductionColumn[]])).min(1).max(productionColumns.length),groups:z.array(z.enum(['factory','customer','stage'])).min(1).max(3)}).strict().refine(value=>new Set(value.columns).size===value.columns.length&&new Set(value.groups).size===value.groups.length);
export type ProductionPreferences=z.infer<typeof preferencesSchema>;
export const defaultProductionPreferences:ProductionPreferences={version:1,columns:['po','customer','demand','received','quality','packed','remaining','customerDate'],groups:['factory','customer','stage']};
/** Preferences contain view configuration only; never a retained report payload. */
export function readProductionPreferences(raw:string|null):ProductionPreferences{
 try{const parsed=preferencesSchema.safeParse(JSON.parse(raw??'null'));return parsed.success?parsed.data:structuredClone(defaultProductionPreferences);}catch{return structuredClone(defaultProductionPreferences);}
}
const currentFilters=(value:Record<string,unknown>)=>Object.fromEntries(['collaboration','timeMode','compareFrom','compareTo','compareElapsed','from','to','customer','category','page','view','snapshotId','factoryId','lineId','salesYear','salesSeries','primaryMerchandiserId','secondaryMerchandiserId','designer','drillLineId','drillOrderId','drillFactoryId','drillMetric','drillFactories','drillCustomers','drillStages','drillStageFactories','groupBy'].filter(key=>value[key]!==undefined).map(key=>[key,value[key]])) as ProductionStatisticsFilters;
const contextSchema=z.object({drawer:z.string().uuid().optional(),group:z.enum(['factory','customer','stage']).optional()}).strict();
export function currentProductionContext(search:string,today:string){
 const params=new URLSearchParams(search),duplicates=[...params.keys()].some(key=>params.getAll(key).length!==1),uiKeys=['drawer','group'],unknown=[...params.keys()].filter(key=>!uiKeys.includes(key)&&!(key in DigitalAnalysisFilterSchema.shape));
 const query=Object.fromEntries([...params].filter(([key])=>key in DigitalAnalysisFilterSchema.shape)),filters=DigitalAnalysisFilterSchema.safeParse({from:today,to:today,...query,view:'production'}),context=contextSchema.safeParse(Object.fromEntries([...params].filter(([key])=>uiKeys.includes(key))));
 if(duplicates||unknown.length||!filters.success||!context.success)return {filters:currentFilters(DigitalAnalysisFilterSchema.parse({from:today,to:today,view:'production'})),drawer:undefined,group:'factory' as ProductionGrouping,error:'当前分析链接含无效条件，请重新应用筛选'};
 return {filters:currentFilters(filters.data),drawer:context.data.drawer,group:context.data.group??'factory',error:''};
}
export function normalizeProductionFilters(filters:Record<string,unknown>){return currentFilters(DigitalAnalysisFilterSchema.parse(filters));}
export function productionQuery(filters:Readonly<Record<string,unknown>>){return new URLSearchParams(Object.entries(filters).filter(([,value])=>value!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,Array.isArray(value)?JSON.stringify(value):String(value)])).toString();}
export function productionGroupFilters(filters:ProductionStatisticsFilters,path:ProductionStatisticsGroup['path']){
 const fields={factory:'drillFactories',customer:'drillCustomers',stage:'drillStages'} as const,next={...filters,page:1,snapshotId:undefined};
 for(const value of path){if(value.dimension==='stage')next.drillStageFactories=next.drillStageFactories??next.drillFactories??(next.drillFactoryId?[next.drillFactoryId]:[]);next[fields[value.dimension]]=[value.key];}
 return normalizeProductionFilters(next);
}
export function productionSourceKey(filters:ProductionStatisticsFilters){return JSON.stringify(Object.entries(filters).filter(([key])=>!['page','snapshotId','drillLineId','drillOrderId','drillFactoryId','drillMetric','drillFactories','drillCustomers','drillStages','drillStageFactories','groupBy'].includes(key)).sort(([a],[b])=>a.localeCompare(b)));}
export function productionReturnQuery(filters:ProductionStatisticsFilters,context:{drawer?:string|undefined;group?:ProductionGrouping|undefined}={}){
 // Returning from an original business page obtains a whole new result. Retain
 // navigation preferences, never splice fresh business facts into an old result.
 const current=Object.fromEntries(Object.entries(filters).filter(([key])=>key!=='snapshotId')) as ProductionStatisticsFilters,query=new URLSearchParams(productionQuery(current));for(const [key,value]of Object.entries(context))if(value!==undefined)query.set(key,value);return query.toString();
}
export function productionMetricText(metric:StatisticsMetric){return metric.value===null?`待核（已知${metric.knownValue}${metric.unit}）`:`${metric.value}${metric.unit}`;}

export function productionAttributionPools(rows:StatisticsCurrentResult['unattributed']){
 return (['received','qualified','packed'] as const).map(kind=>{const items=rows.filter(item=>item.kind===kind),known=items.reduce((sum,item)=>sum+(item.quantity??0),0),unknown=items.filter(item=>item.quantity===null).length;return {kind,items,known,quantity:unknown?null:known,unknown};}).filter(pool=>pool.items.length>0);
}

const navigationSchema=z.object({version:z.literal(1),target:z.string().max(6000),session:z.string().max(20000),at:z.number().finite(),scroll:z.number().min(0).max(10000000),focus:z.string().max(200),expanded:z.array(z.string().max(4096)).max(1000)}).strict();
/** One tab-scoped navigation preference, never report or authorization data. */
export function readProductionNavigation(raw:string|null,target:string,session:string,now=Date.now()){
 try{const parsed=navigationSchema.safeParse(JSON.parse(raw??'null'));return parsed.success&&parsed.data.target===target&&parsed.data.session===session&&now>=parsed.data.at&&now-parsed.data.at<=15*60*1000?parsed.data:null;}catch{return null;}
}

/** Separate request turns distinguish A1/B/A2 even when the A source key repeats. */
export class ProductionReadOwnership{
 private turn=0;
 begin(source:string,session:string){return {turn:++this.turn,source,session};}
 current(request:{turn:number;source:string;session:string},source:string,session:string){return request.turn===this.turn&&request.source===source&&request.session===session;}
 invalidate(){++this.turn;}
}
