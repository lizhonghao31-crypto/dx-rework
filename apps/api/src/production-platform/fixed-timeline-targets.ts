import {slaAnchorTime,type SlaAnchor,type SlaTime} from '@dx-rework/domain/digital-sla-plan';

export type FixedTimelineCalendar='continuous'|'natural_days'|'beijing_sunday_excluded';
export type FixedTimelineWork={
 id:string;dependsOn:readonly string[];minutes:number|null;calendar:FixedTimelineCalendar|null;
 includedIn?:string;includedPosition?:'start'|'end';
};
export type FixedTimelineTarget={id:string;start:SlaTime;end:SlaTime};
const MINUTE=60000,BEIJING=8*60*MINUTE;
const instant=(value:string)=>{
 const result=Date.parse(value);
 if(!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(result))throw Error('固定计划需要可信具体时刻');
 return result;
};

/** Original contract Sunday calendar for nonzero movement. Zero preserves the
 * physical instant, including Sunday; it is not a request to find a workday.
 */
export function shiftFixedTimeline(value:string,minutes:number,calendar:FixedTimelineCalendar):string{
 let clock=instant(value),remaining=Math.round(Math.abs(minutes)*MINUTE);
 if(!Number.isFinite(minutes)||!Number.isSafeInteger(remaining)||Math.abs(Math.abs(minutes)*MINUTE-remaining)>1e-6)throw Error('固定计划时长须为合法毫秒精度');
 if(!['continuous','natural_days','beijing_sunday_excluded'].includes(calendar))throw Error('固定计划日历未采用');
 if(!remaining)return value;
 if(calendar!=='beijing_sunday_excluded')return new Date(clock+Math.sign(minutes)*remaining).toISOString();
 if(minutes>0){
  while(true){
   const local=new Date(clock+BEIJING),next=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate()+1)-BEIJING;
   if(local.getUTCDay()===0){clock=next;continue;}
   if(!remaining)return new Date(clock).toISOString();
   const available=next-clock;
   if(remaining<available)return new Date(clock+remaining).toISOString();
   remaining-=available;clock=next;
  }
 }
 while(remaining){
  // At midnight, subtraction belongs to the day immediately before it.
  const local=new Date(clock-1+BEIJING),previous=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate())-BEIJING;
  if(local.getUTCDay()===0){clock=previous;continue;}
  const used=Math.min(remaining,clock-previous);clock-=used;remaining-=used;
 }
 return new Date(clock).toISOString();
}

/** Reverse only the adopted graph, never actual progress/forecast or now.
 * Per-consumer deadlines are inputs; this does not mutate shared source work.
 * Included handoffs use their parent window and never add a second duration.
 */
export function fixedTimelineTargets(work:readonly FixedTimelineWork[],ends:Readonly<Record<string,SlaAnchor>>,options:{preserveUnknown?:boolean;endTimes?:Readonly<Record<string,SlaTime>>}={}):FixedTimelineTarget[]{
 const missing=(...reasons:string[]):SlaTime=>({at:null,exclusive:false,reasons:[...new Set(reasons)]});
 const nodes=new Map(work.map(node=>[node.id,node]));
 if(nodes.size!==work.length)throw Error('固定计划工作身份重复');
 const ordered:FixedTimelineWork[]=[],visited=new Set<string>(),visiting=new Set<string>();
 const visit=(id:string)=>{
  if(visited.has(id))return;
  if(visiting.has(id))throw Error('固定计划依赖成环');
  const node=nodes.get(id);if(!node)throw Error('固定计划缺少依赖工作');
  if(!node.id||node.minutes!==null&&(!Number.isFinite(node.minutes)||node.minutes<0)||new Set(node.dependsOn).size!==node.dependsOn.length
   ||node.calendar!==null&&!['continuous','natural_days','beijing_sunday_excluded'].includes(node.calendar))throw Error('固定计划工作参数无效');
  if(!options.preserveUnknown&&(node.minutes===null||node.calendar===null))throw Error('固定计划缺少原采用时长或日历');
  visiting.add(id);
  for(const dep of node.dependsOn){if(nodes.get(dep)?.includedIn)throw Error('内含交接不能重复成为独立路径');visit(dep);}
  if(node.includedIn){if(node.dependsOn.length)throw Error('内含交接不能另有独立依赖');visit(node.includedIn);}
  visiting.delete(id);visited.add(id);ordered.push(node);
 };
 for(const node of work)visit(node.id);
 for(const parent of work){
  const included=work.filter(node=>node.includedIn===parent.id);
  if(parent.minutes!==null&&included.reduce((total,node)=>total+(node.minutes??0),0)>parent.minutes)throw Error('内含交接合计不能超过父窗口');
 }
 const deadlines=new Map<string,SlaTime[]>();
 for(const [id,anchor]of Object.entries(ends)){
  if(!nodes.has(id)||nodes.get(id)!.includedIn)throw Error('固定计划终点必须对应原独立工作');
  const time=slaAnchorTime(anchor,id);if(!time.at&&!options.preserveUnknown)throw Error('固定计划终点缺少真实采用依据');
  deadlines.set(id,[time]);
 }
 for(const [id,time]of Object.entries(options.endTimes??{})){
  if(!nodes.has(id)||nodes.get(id)!.includedIn)throw Error('固定计划约束不属于原独立工作');
  if(time.at!==null)instant(time.at);
  deadlines.set(id,[structuredClone(time)]);
 }
 const targets=new Map<string,FixedTimelineTarget>();
 for(const node of [...ordered].reverse()){
  if(node.includedIn)continue;
  let candidates=deadlines.get(node.id);
  if(!candidates?.length){if(!options.preserveUnknown)throw Error('适用工作缺少交付或来源目标');candidates=[missing('缺少本范围正式目标')];}
  const end=candidates.some(time=>time.at===null)?missing(...candidates.flatMap(time=>time.reasons))
   :candidates.reduce((a,b)=>instant(a.at!)<instant(b.at!)||instant(a.at!)===instant(b.at!)&&a.exclusive?a:b);
  const start=end.at===null?{...end,reasons:[...end.reasons]}:node.minutes===0?{...end,reasons:[...end.reasons]}
   :node.minutes===null||node.calendar===null?missing(node.minutes===null?'尚未采用本工作规划时长':'尚未采用本工作计时日历')
   :{...end,at:shiftFixedTimeline(end.at,-node.minutes,node.calendar),reasons:[...end.reasons]};
  targets.set(node.id,{id:node.id,start,end:{...end,reasons:[...end.reasons]}});
  for(const dep of node.dependsOn)deadlines.set(dep,[...(deadlines.get(dep)??[]),start]);
 }
 for(const node of ordered.filter(node=>node.includedIn)){
  const parent=targets.get(node.includedIn!)!,owner=nodes.get(node.includedIn!)!;
  if(owner.includedIn||node.minutes!==null&&owner.minutes!==null&&node.minutes>owner.minutes||node.calendar!==null&&owner.calendar!==null&&node.calendar!==owner.calendar)throw Error('内含交接必须沿原父窗口和日历');
  const shift=(base:SlaTime,direction:number)=>base.at===null?{...base,reasons:[...base.reasons]}:node.minutes===0?{...base}
   :node.minutes===null||node.calendar===null?missing('内含交接规划时长或父窗口日历待补'):{...base,at:shiftFixedTimeline(base.at,direction*node.minutes,node.calendar)};
  const start=node.includedPosition==='end'?shift(parent.end,-1):{...parent.start};
  const end=node.includedPosition==='end'?{...parent.end}:shift(parent.start,1);
  targets.set(node.id,{id:node.id,start,end});
 }
 return work.map(node=>targets.get(node.id)!);
}
