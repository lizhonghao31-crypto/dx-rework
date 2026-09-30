import type { ProductionDashboardItem, ProductionDashboardEvent } from "@dx-rework/contracts";
export const productionStatusLabels={in_production:"生产中",production_completed:"生产完成",shipped:"已发货"} as const;
export const progressLabels={pending_first_report:"待首次上报",normal:"进度正常",behind:"进度落后",high_risk:"高风险",stale:"未更新",completed:"已完成"} as const;
export function progressText(progress:ProductionDashboardItem["progress"]) {
  return progress.progressState==="stale"?`${progress.daysWithoutUpdate}天没更新`:progressLabels[progress.progressState];
}
export function changedDashboardOrders(before:ProductionDashboardItem[],after:ProductionDashboardItem[]):string[] {
  const prior=new Map(before.map(item=>[item.order.productionOrderId,JSON.stringify(item)]));
  return after.filter(item=>prior.get(item.order.productionOrderId)!==JSON.stringify(item)).map(item=>item.order.productionOrderId);
}
export const canMoveProductionEvents=(count:number,paused:boolean,hovered:boolean,focused:boolean,reduced:boolean)=>count>=3&&!paused&&!hovered&&!focused&&!reduced;
export function productionEventText(event:ProductionDashboardEvent):string {
  if(event.kind==="progress_changed")return `刷新发现：${event.previousState?progressLabels[event.previousState]:""} → ${event.progressState==="stale"?`${event.daysWithoutUpdate}天没更新`:event.progressState?progressLabels[event.progressState]:""}`;
  return ({report:"新增生产",correct:"Root修正记录为",complete:"生产完成",ship:"已发货"})[event.kind];
}


// Animation never changes server-supplied quantities, progress or risk.
export function canAnimateProductionProgress(item:ProductionDashboardItem,motion:boolean):boolean {
  return motion&&item.order.status==='in_production'&&!item.progress.frozen&&!!item.progress.firstReportedOn&&item.progress.productionProgress>0&&item.progress.progressState!=='stale'&&item.progress.progressState!=='pending_first_report'&&item.progress.progressState!=='completed';
}
export function relativeProductionTime(value:string,now:number):string {
  const minutes=Math.max(0,Math.floor((now-new Date(value).getTime())/60000));
  return minutes<1?'不到1分钟':minutes<60?`${minutes}分钟`:minutes<1440?`${Math.floor(minutes/60)}小时${minutes%60?`${minutes%60}分钟`:''}`:`${Math.floor(minutes/1440)}天`;
}


/** The local motion control is reserved for the authenticated Root account. */
export function canControlProductionMotion(user:{isRoot?:boolean}|null|undefined){return user?.isRoot===true;}
