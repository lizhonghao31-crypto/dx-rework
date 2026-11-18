import {slaAnchorTime,type SlaAnchor,type SlaTime} from '@dx-rework/domain/digital-sla-plan';

export type FixedTimelineCalendar='continuous'|'natural_days'|'beijing_sunday_excluded';
export type FixedTimelineWork={
 id:string;dependsOn:readonly string[];minutes:number|null;calendar:FixedTimelineCalendar|null;
 includedIn?:string;includedPosition?:'start'|'end';
 nativeDuration?:{reference:string;minutes:number|null;calendar:FixedTimelineCalendar|null};
 dependencyReserves?:Readonly<Record<string,{minutes:number;calendar:FixedTimelineCalendar}>>;
};
export type FixedTimelineTarget={id:string;start:SlaTime;end:SlaTime};
const MINUTE=60000,BEIJING=8*60*MINUTE,DAY=24*60*MINUTE,WEEK=7*DAY,WORK_WEEK=6*DAY;
const DATE_LIMIT=8_640_000_000_000_000;
const precisionError=()=>Error('固定计划时长须为合法毫秒精度');
const checkedInstant=(value:number)=>{
 if(!Number.isSafeInteger(value)||Math.abs(value)>DATE_LIMIT)throw Error('固定计划时刻超出有效范围');
 return value;
};
const instant=(value:string)=>{
 const result=Date.parse(value);
 if(!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(result))throw Error('固定计划需要可信具体时刻');
 return result;
};
const localDay=(clock:number)=>Math.floor((clock+BEIJING)/DAY);
const dayStart=(day:number)=>day*DAY-BEIJING;
const weekday=(day:number)=>((day+4)%7+7)%7; // 1970-01-01 was Thursday.
const checkCalendar=(calendar:FixedTimelineCalendar)=>{
 if(calendar!=='continuous'&&calendar!=='natural_days'&&calendar!=='beijing_sunday_excluded')throw Error('固定计划日历未采用');
};

export function fixedMinutesToMilliseconds(minutes:number):number{
 const magnitude=Math.abs(minutes),raw=magnitude*MINUTE,integer=Math.round(raw);
 if(!Number.isFinite(minutes)||!Number.isSafeInteger(integer))throw precisionError();
 if(Math.abs(raw-integer)>1e-6){
  // An internally derived integer / MINUTE can multiply back one ULP away.
  // Recover only its unambiguous canonical encoding, with the old tolerance.
  if(magnitude!==integer/MINUTE||!Number.isSafeInteger(integer-1)||!Number.isSafeInteger(integer+1)
   ||magnitude===(integer-1)/MINUTE||magnitude===(integer+1)/MINUTE)throw precisionError();
 }
 return minutes<0?-integer:integer;
}

function skipCalendarWeeks(clock:number,weeks:number):number{
 const delta=weeks*WEEK;
 if(Number.isSafeInteger(delta))return checkedInstant(clock+delta);
 // Physical time can exceed the safe span even when the resulting Date fits.
 return checkedInstant(Number(BigInt(clock)+BigInt(weeks)*BigInt(WEEK)));
}

/** Original contract Sunday calendar for nonzero movement. Zero preserves the
 * physical instant, including Sunday; it is not a request to find a workday.
 */
export function shiftFixedTimeline(value:string,minutes:number,calendar:FixedTimelineCalendar):string{
 const clock=instant(value),milliseconds=fixedMinutesToMilliseconds(minutes);
 const shifted=shiftFixedTimelineMilliseconds(clock,milliseconds,calendar);
 return milliseconds===0?value:new Date(shifted).toISOString();
}

export function shiftFixedTimelineMilliseconds(clock:number,milliseconds:number,calendar:FixedTimelineCalendar):number{
 checkedInstant(clock);checkCalendar(calendar);
 if(!Number.isSafeInteger(milliseconds))throw precisionError();
 if(milliseconds===0)return clock;
 if(calendar!=='beijing_sunday_excluded')return checkedInstant(clock+milliseconds);
 let remaining=Math.abs(milliseconds);
 if(milliseconds>0){
  while(true){
   const day=localDay(clock),next=dayStart(day+1),dayOfWeek=weekday(day);
   if(dayOfWeek===0){clock=checkedInstant(next);continue;}
   if(!remaining)return clock;
   if(dayOfWeek===1&&clock===dayStart(day)&&remaining>=WORK_WEEK){
    const weeks=Math.floor(remaining/WORK_WEEK);
    clock=skipCalendarWeeks(clock,weeks);remaining-=weeks*WORK_WEEK;continue;
   }
   const available=next-clock;
   if(remaining<available)return checkedInstant(clock+remaining);
   remaining-=available;clock=checkedInstant(next);
  }
 }
 while(remaining){
  const day=localDay(clock);
  if(weekday(day)===1&&clock===dayStart(day)&&remaining>=WORK_WEEK){
   const weeks=Math.floor(remaining/WORK_WEEK);
   clock=skipCalendarWeeks(clock,-weeks);remaining-=weeks*WORK_WEEK;continue;
  }
  // At midnight, subtraction belongs to the day immediately before it.
  const previousDay=localDay(clock-1),previous=dayStart(previousDay);
  if(weekday(previousDay)===0){clock=checkedInstant(previous);continue;}
  const used=Math.min(remaining,clock-previous);clock=checkedInstant(clock-used);remaining-=used;
 }
 return clock;
}

export function fixedTimelineElapsedMilliseconds(from:number,to:number,calendar:FixedTimelineCalendar):number{
 checkedInstant(from);checkedInstant(to);checkCalendar(calendar);
 const span=to-from;
 if(!Number.isSafeInteger(span))throw precisionError();
 if(span===0||calendar!=='beijing_sunday_excluded')return span;
 const length=Math.abs(span),weeks=Math.floor(length/WEEK),end=Math.max(from,to);
 let at=Math.min(from,to)+weeks*WEEK,total=weeks*WORK_WEEK;
 while(at<end){
  const day=localDay(at),next=Math.min(end,dayStart(day+1));
  if(weekday(day)!==0)total+=next-at;
  at=next;
 }
 return span<0?-total:total;
}

function orderedFixedWork(work:readonly FixedTimelineWork[],preserveUnknown:boolean){
 const nodes=new Map(work.map(node=>[node.id,node]));
 if(nodes.size!==work.length)throw Error('固定计划工作身份重复');
 const ordered:FixedTimelineWork[]=[],visited=new Set<string>(),visiting=new Set<string>();
 const visit=(id:string)=>{
  if(visited.has(id))return;
  if(visiting.has(id))throw Error('固定计划依赖成环');
  const node=nodes.get(id);if(!node)throw Error('固定计划缺少依赖工作');
  if(!node.id||node.minutes!==null&&(!Number.isFinite(node.minutes)||node.minutes<0)||new Set(node.dependsOn).size!==node.dependsOn.length
   ||node.calendar!==null&&!['continuous','natural_days','beijing_sunday_excluded'].includes(node.calendar))throw Error('固定计划工作参数无效');
  for(const [id,reserve]of Object.entries(node.dependencyReserves??{}))if(!node.dependsOn.includes(id)||!Number.isFinite(reserve.minutes)||reserve.minutes<0||reserve.minutes>525600||!['continuous','natural_days','beijing_sunday_excluded'].includes(reserve.calendar))throw Error('阶段预留必须属于真实依赖且用时有效');
  if(!preserveUnknown&&(node.minutes===null||node.calendar===null))throw Error('固定计划缺少原采用时长或日历');
  visiting.add(id);
  for(const dep of node.dependsOn){if(nodes.get(dep)?.includedIn)throw Error('内含交接不能重复成为独立路径');visit(dep);}
  if(node.includedIn){if(node.dependsOn.length)throw Error('内含交接不能另有独立依赖');visit(node.includedIn);}
  visiting.delete(id);visited.add(id);ordered.push(node);
 };
 for(const node of work)visit(node.id);
 for(const parent of work){
  const included=work.filter(node=>node.includedIn===parent.id);
  if(parent.minutes!==null&&included.reduce((total,node)=>total+(node.minutes??0),0)>parent.minutes)throw Error('内含交接合计不能超过父窗口');
  for(const child of included)if(parent.includedIn||child.calendar!==null&&parent.calendar!==null&&child.calendar!==parent.calendar)throw Error('内含交接必须沿原父窗口和日历');
 }
 return {nodes,ordered};
}

/** Reverse only the adopted graph, never actual progress/forecast or now.
 * Per-consumer deadlines are inputs; this does not mutate shared source work.
 * Included handoffs use their parent window and never add a second duration.
 */
export function fixedTimelineTargets(work:readonly FixedTimelineWork[],ends:Readonly<Record<string,SlaAnchor>>,options:{preserveUnknown?:boolean;endTimes?:Readonly<Record<string,SlaTime>>;fixedTargets?:Readonly<Record<string,FixedTimelineTarget>>}={}):FixedTimelineTarget[]{
 const missing=(...reasons:string[]):SlaTime=>({at:null,exclusive:false,reasons:[...new Set(reasons)]});
 const {nodes,ordered}=orderedFixedWork(work,options.preserveUnknown===true);
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
  const fixed=options.fixedTargets?.[node.id];
  if(fixed){
   if(fixed.id!==node.id)throw Error('保留目标与原节点身份不一致');
   if(fixed.start.at)instant(fixed.start.at);if(fixed.end.at)instant(fixed.end.at);
   targets.set(node.id,structuredClone(fixed));
   // Keep original displayed B. Newly inserted predecessors must fit before
   // the remaining adopted work ending at that unchanged completion goal.
   const currentStart=fixed.end.at===null?{...fixed.end,reasons:[...fixed.end.reasons]}:node.minutes===0?{...fixed.end}
    :node.minutes===null||node.calendar===null?missing('后续本单采用用时或日历待核')
    :{...fixed.end,at:shiftFixedTimeline(fixed.end.at,-node.minutes,node.calendar)};
   for(const dep of node.dependsOn){const reserve=node.dependencyReserves?.[dep],start=currentStart;
    const handoff=reserve&&start.at?{...start,at:shiftFixedTimeline(start.at,-reserve.minutes,reserve.calendar),reasons:[...start.reasons]}:start;
    deadlines.set(dep,[...(deadlines.get(dep)??[]),handoff]);}
   continue;
  }
  let candidates=deadlines.get(node.id);
  if(!candidates?.length){if(!options.preserveUnknown)throw Error('适用工作缺少交付或来源目标');candidates=[missing('缺少本范围正式目标')];}
  const end=candidates.some(time=>time.at===null)?missing(...candidates.flatMap(time=>time.reasons))
   :candidates.reduce((a,b)=>instant(a.at!)<instant(b.at!)||instant(a.at!)===instant(b.at!)&&a.exclusive?a:b);
  const start=end.at===null?{...end,reasons:[...end.reasons]}:node.minutes===0?{...end,reasons:[...end.reasons]}
   :node.minutes===null||node.calendar===null?missing(node.minutes===null?'尚未采用本工作规划时长':'尚未采用本工作计时日历')
   :{...end,at:shiftFixedTimeline(end.at,-node.minutes,node.calendar),reasons:[...end.reasons]};
  targets.set(node.id,{id:node.id,start,end:{...end,reasons:[...end.reasons]}});
  for(const dep of node.dependsOn){
   const reserve=node.dependencyReserves?.[dep];
   const handoff=reserve&&start.at?{...start,at:shiftFixedTimeline(start.at,-reserve.minutes,reserve.calendar),reasons:[...start.reasons]}:start;
   deadlines.set(dep,[...(deadlines.get(dep)??[]),handoff]);
  }
 }
 for(const node of ordered.filter(node=>node.includedIn)){
  const fixed=options.fixedTargets?.[node.id];if(fixed){if(fixed.id!==node.id)throw Error('保留目标与原节点身份不一致');targets.set(node.id,structuredClone(fixed));continue;}
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

/** Exact forward arrangement on the same validated DAG/calendars. The inputs
 * are planning assumptions, never completion events or employee clock starts.
 * The rolling projection may replace a window with a trusted observation
 * before its downstream work is evaluated. It does not change the graph.
 */
export function fixedTimelineForward(work:readonly FixedTimelineWork[],start:SlaAnchor,notBefore:Readonly<Record<string,SlaAnchor>>={},options:{minimumStart?:SlaAnchor;retained?:Readonly<Record<string,FixedTimelineTarget>>;completions?:Readonly<Record<string,SlaTime>>;project?:(target:Readonly<FixedTimelineTarget>)=>Pick<FixedTimelineTarget,'start'|'end'>}={}):FixedTimelineTarget[]{
 const {ordered}=orderedFixedWork(work,true),targets=new Map<string,FixedTimelineTarget>();
 const record=(target:FixedTimelineTarget)=>{
  const projection=options.project?.(target);
  targets.set(target.id,projection?{...target,...projection}:target);
 };
 for(const [id,row]of Object.entries(options.retained??{})){
  if(row.id!==id||!work.some(node=>node.id===id))throw Error('保留安排不属于本范围工作');
  if(row.start.at)instant(row.start.at);if(row.end.at)instant(row.end.at);
  if(row.start.at&&row.end.at&&instant(row.end.at)<instant(row.start.at))throw Error('保留安排结束早于开始');
 }
 for(const [id,time]of Object.entries(options.completions??{})){
  if(!options.retained?.[id])throw Error('实际完成边界必须引用保留的本范围工作');
  if(time.at)instant(time.at);else if(!time.reasons.length)throw Error('未知实际完成时间须保留原因');
 }
 const missing=(...reasons:string[]):SlaTime=>({at:null,exclusive:false,reasons:[...new Set(reasons)]});
 const initial=slaAnchorTime(start,'本次安排开始');
 for(const node of ordered){
  if(node.includedIn)continue;
  const retained=options.retained?.[node.id];if(retained){targets.set(node.id,structuredClone(retained));continue;}
  const candidates=node.dependsOn.length?node.dependsOn.map(id=>{
   const end=options.completions?.[id]??targets.get(id)!.end,reserve=node.dependencyReserves?.[id];
   return end.at&&reserve?{...end,at:shiftFixedTimeline(end.at,reserve.minutes,reserve.calendar),reasons:[...end.reasons]}:end;
  }):[initial];
  if(notBefore[node.id])candidates.push(slaAnchorTime(notBefore[node.id]!,`本节点预计前提:${node.id}`));
  if(options.minimumStart)candidates.push(slaAnchorTime(options.minimumStart,'本次提交的剩余工作下界'));
  const begin=candidates.some(value=>value.at===null)?missing(...candidates.flatMap(value=>value.reasons))
   :candidates.reduce((a,b)=>instant(a.at!)>instant(b.at!)||instant(a.at!)===instant(b.at!)&&a.exclusive?a:b);
  const end=begin.at===null?{...begin,reasons:[...begin.reasons]}:node.minutes===0?{...begin}
   :node.minutes===null||!node.calendar?missing(node.minutes===null?'本工作用时尚未采用':'本工作日历尚未采用')
   :{...begin,at:shiftFixedTimeline(begin.at,node.minutes,node.calendar),reasons:[...begin.reasons]};
  record({id:node.id,start:begin,end});
 }
 for(const node of ordered.filter(node=>node.includedIn)){
  const retained=options.retained?.[node.id];if(retained){targets.set(node.id,structuredClone(retained));continue;}
  const parent=targets.get(node.includedIn!)!,base=node.includedPosition==='end'?parent.end:parent.start;
  const moved=base.at===null?{...base,reasons:[...base.reasons]}:node.minutes===0?{...base}
   :node.minutes===null||!node.calendar?missing('内含交接用时或日历待核')
   :{...base,at:shiftFixedTimeline(base.at,(node.includedPosition==='end'?-1:1)*node.minutes,node.calendar),reasons:[...base.reasons]};
  record({id:node.id,start:node.includedPosition==='end'?moved:{...base},end:node.includedPosition==='end'?{...base}:moved});
 }
 return work.map(node=>targets.get(node.id)!);
}

/** Only the necessary ancestors of real delivery terminals determine its span. */
export function requiredFixedTimelineWork(work:readonly FixedTimelineWork[],terminalIds:readonly string[]):FixedTimelineWork[]{
 const {nodes}=orderedFixedWork(work,true),selected=new Set<string>();
 const visit=(id:string)=>{if(selected.has(id))return;const node=nodes.get(id);if(!node)throw Error('缺少原交付终点或依赖');selected.add(id);for(const dep of node.dependsOn)visit(dep);if(node.includedIn)visit(node.includedIn);};
 for(const id of terminalIds)visit(id);
 return work.filter(node=>selected.has(node.id));
}
