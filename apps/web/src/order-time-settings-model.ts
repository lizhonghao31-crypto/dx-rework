import type {OrderTimeRule} from '@dx-rework/contracts/order-time-plan';
import {ORDER_TIME_NODES,type OrderTimeConfiguration,type OrderTimeHistoryRecord} from '@dx-rework/contracts/order-time-settings';
export function historyTimeText(row:OrderTimeHistoryRecord){const group=row.kind==='legacy_development'?'开发周期':row.kind==='legacy_unified'?'时效':'设置';return `${new Date(row.recordedAt).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'})}保存的${group} · 第${row.version}版${row.partial?'（记录不完整）':''}`;}
export const timeCalendars={continuous:'连续计时，周末也算',natural_days:'每天按24小时计时',beijing_sunday_excluded:'周日不算，其余天照算'} as const;
export function timeText(minutes:number|null){
 if(minutes===null)return '还没设置';if(minutes===0)return '0小时';if(minutes>0&&minutes<1)return '不足1分钟';
 const days=Math.floor(minutes/1440),hours=Math.floor((minutes-days*1440)/60),rest=minutes-days*1440-hours*60;
 return [days?days+'天':'',hours?hours+'小时':'',rest?Number(rest.toFixed(4))+'分钟':''].join('');
}
export function includedTimeOwner(key:string){return ORDER_TIME_NODES.find(n=>n.key===key)?.includedIn?.map(k=>ORDER_TIME_NODES.find(n=>n.key===k)?.label).join('／')??'对应工序';}
export function nodeTimeText(rule:OrderTimeRule,key?:string){
 return rule.kind==='event'?'按实际办理记录':rule.kind==='date'?'按工厂交货日':rule.kind==='offset'?rule.days===null?'还没设置':'提前'+rule.days+'天':rule.kind==='included'&&key?timeText(rule.minutes)+'，已含在'+includedTimeOwner(key)+'用时内':timeText(rule.minutes);
}
export function nodeCalendarText(rule:OrderTimeRule,key:string){
 const node=ORDER_TIME_NODES.find(n=>n.key===key);
 if(rule.kind==='included')return '跟随'+(node?.includedIn?.map(k=>ORDER_TIME_NODES.find(n=>n.key===k)?.label).join('／')??'所属工序');
 return rule.kind==='event'||rule.kind==='date'||rule.kind==='offset'?'—':rule.calendar?timeCalendars[rule.calendar]:'还没设置';
}
export function setNodeTime(values:OrderTimeConfiguration,key:string,rule:OrderTimeRule):OrderTimeConfiguration{return {...values,nodes:{...values.nodes,[key]:rule}};}
export function beijingLocalInput(instant:string){return new Date(Date.parse(instant)+8*3600000).toISOString().slice(0,16);}
export function beijingInputInstant(input:string){const date=new Date(input+':00+08:00');return Number.isNaN(date.getTime())?null:date.toISOString();}
