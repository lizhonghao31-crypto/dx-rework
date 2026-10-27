import type {DigitalAnalysisFilters,DigitalAnalysisOverview} from '@dx-rework/contracts/digital-production-analysis';
import {summarizeAnalysis,isMaterialWaiting} from './reporting-metrics.js';
import type {taskAnalysis} from './reporting-metrics.js';
export const WORKSPACE_ANALYSIS_RULE_VERSION='digital-production-v2-analysis-2';
export type AnalysisWorkspaceRow=ReturnType<typeof taskAnalysis>&{sourcePublishedAt?:string|null};
export type PublishedAnalysisRound={sourceId:string;round:number;origin:string;publishedAt:string};
const inRange=(value:string|null|undefined,from:string,to:string)=>Boolean(value&&value>=from&&value<to);
export const currentAnalysisRow=(row:AnalysisWorkspaceRow)=>!['completed','cancelled'].includes(row.state);
export function isAnalysisOverdue(row:AnalysisWorkspaceRow,asOf:string){
 const now=Date.parse(row.businessTime?.now??asOf);
 return currentAnalysisRow(row)&&Boolean(row.dueAt&&(row.deadlineMode==='date_target'?Date.parse(row.dueAt)<=now:row.enteredAt&&Date.parse(row.enteredAt)<=now&&Date.parse(row.dueAt)<now));
}
export function workspaceAnalysisRows<Row extends AnalysisWorkspaceRow>(rows:Row[],rounds:PublishedAnalysisRound[],filters:DigitalAnalysisFilters,from:string,to:string,asOf:string){
 const publishedRounds=new Set(rounds.filter(round=>!filters.origin||round.origin===filters.origin).map(round=>`${round.sourceId}:${round.round}`));
 return rows.filter(row=>{
  if(filters.assigneeId&&row.assigneeId!==filters.assigneeId)return false;
  if(filters.cycle){const index=['under_day','one_three','three_seven','over_week'].indexOf(filters.cycle),bounds=[0,86400,3*86400,7*86400,Infinity];if(row.handlingSeconds===null||row.handlingSeconds<bounds[index]!||row.handlingSeconds>=bounds[index+1]!)return false;}
  if(filters.node&&row.nodeKey!==filters.node)return false;
  if(filters.scope==='snapshot'&&!currentAnalysisRow(row))return false;
  if(filters.scope==='completed'&&!(row.state==='completed'&&inRange(row.completedAt,from,to)))return false;
  if(filters.scope==='published'&&!inRange(row.sourcePublishedAt,from,to))return false;
  if(filters.scope==='revisions'&&(row.sourceRound==null||!publishedRounds.has(`${row.sourceId}:${row.sourceRound}`)))return false;
  if((!filters.scope||filters.scope==='created')&&!inRange(row.createdAt,from,to))return false;
  switch(filters.metric){
   case 'shipping':return row.nodeKey==='development_shipping'&&row.state==='completed';
   case 'active':return row.state==='ready';
   case 'pending':return row.state==='pending';
   case 'unassigned':return currentAnalysisRow(row)&&!row.assigneeId;
   case 'blocked':return row.state==='blocked';
   case 'overdue':return isAnalysisOverdue(row,asOf);
   case 'sla':return row.slaIncluded;
   case 'late':return row.slaIncluded&&row.onTime===false;
   case 'measurable':return row.handlingSeconds!==null;
   case 'materials':return isMaterialWaiting(row);
   case 'handover':return row.pendingConditions.includes('handover_received');
   case 'other_wait':return row.state==='blocked'&&!row.pendingConditions.length;
   case 'waiting':return row.waitingSeconds>0;
   case 'unknown_wait':return row.unknownWaiting>0;
   case 'missing':return row.missingTime;
   case 'unverified':return row.unverifiedTime;
   default:return true;
  }
 });
}
export function analysisWorkspaceOverview(rows:AnalysisWorkspaceRow[],from:string,to:string,asOf:string):DigitalAnalysisOverview{
 const completed=rows.filter(row=>row.state==='completed'&&inRange(row.completedAt,from,to)),current=rows.filter(currentAnalysisRow),summary=summarizeAnalysis(completed,from,to);
 const published=new Set(rows.filter(row=>row.sourceId&&inRange(row.sourcePublishedAt,from,to)).map(row=>row.sourceId));
 const shipping=new Set(completed.filter(row=>row.nodeKey==='development_shipping').map(row=>`${row.sourceId??row.orderId}:${row.sourceRound}`));
 const nodeKeys=[...new Set(rows.map(row=>row.nodeKey))];
 const bounds=[0,86400,3*86400,7*86400,Infinity],labels=['不足1天','1–3天','3–7天','7天及以上'];
 return {period:{newStyles:published.size,shippedRounds:shipping.size,completed:completed.length,slaDenominator:summary.slaDenominator,onTime:summary.onTime,measurable:summary.measurable,missingTime:summary.missingTime,unverifiedTime:summary.unverifiedTime,handlingSeconds:summary.handlingSeconds,waitingSeconds:summary.waitingSeconds,unknownWaiting:summary.unknownWaiting,cycleBuckets:labels.map((label,index)=>({key:(['under_day','one_three','three_seven','over_week'] as const)[index]!,label,count:completed.filter(row=>row.handlingSeconds!==null&&row.handlingSeconds>=bounds[index]!&&row.handlingSeconds<bounds[index+1]!).length}))},snapshot:{active:current.filter(row=>row.state==='ready').length,pending:current.filter(row=>row.state==='pending').length,unassigned:current.filter(row=>!row.assigneeId).length,blocked:current.filter(row=>row.state==='blocked').length,overdue:current.filter(row=>isAnalysisOverdue(row,asOf)).length,materialPending:current.filter(isMaterialWaiting).length,handoverPending:current.filter(row=>row.pendingConditions.includes('handover_received')).length,otherBlocked:current.filter(row=>row.state==='blocked'&&!row.pendingConditions.length).length},nodes:nodeKeys.map(key=>{const period=completed.filter(row=>row.nodeKey===key);return {key,label:rows.find(row=>row.nodeKey===key)!.label,overdue:current.filter(row=>row.nodeKey===key&&isAnalysisOverdue(row,asOf)).length,completed:period.length,slaDenominator:period.filter(row=>row.slaIncluded).length,onTime:period.filter(row=>row.onTime===true).length};})};
}
