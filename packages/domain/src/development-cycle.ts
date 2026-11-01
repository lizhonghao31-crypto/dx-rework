export type DevelopmentExternalInterval={id:string;departedAt:string|null;returnedAt:string|null;credible:boolean;closed:boolean};
/** Continuous natural time; deduct a union of real intervals, never planned lead times. */
export function calculateDevelopmentCycle(input:{publishedAt:string;completedAt:string|null;internalCompleted?:boolean;now:string;allowedDays:number;warningRatio:number;intervals:DevelopmentExternalInterval[]}){
 const start=Date.parse(input.publishedAt),now=Date.parse(input.now),end=input.completedAt?Date.parse(input.completedAt):now;
 if(!Number.isFinite(start)||!Number.isFinite(now)||!Number.isFinite(end)||end<start||end>now||!Number.isFinite(input.allowedDays)||input.allowedDays<=0||input.warningRatio<=0||input.warningRatio>=1)throw Error('Invalid development cycle basis');
 const reasons:string[]=input.internalCompleted&&!input.completedAt?['尾查已完成，实际完成时间尚待核实']:[],segments:Array<[number,number]>=[];let open=false;
 for(const interval of input.intervals){
  if(!interval.credible){reasons.push(`${interval.id}：外发时间尚未核实`);continue;}
  const a=interval.departedAt?Date.parse(interval.departedAt):NaN,b=interval.returnedAt?Date.parse(interval.returnedAt):end;
  if(!Number.isFinite(a)||!Number.isFinite(b)||b<a||a>now||b>now){reasons.push(`${interval.id}：缺可信外发起止`);continue;}
  if((interval.closed||input.completedAt)&&!interval.returnedAt){reasons.push(`${interval.id}：已结束但缺实际回收时间`);continue;}
  if(!interval.returnedAt&&!input.completedAt)open=true;
  const left=Math.max(a,start),right=Math.min(b,end);if(right>left)segments.push([left,right]);
 }
 segments.sort((a,b)=>a[0]-b[0]);let excluded=0,left:number|null=null,right=0;
 for(const [a,b] of segments){if(left===null){left=a;right=b;}else if(a<=right)right=Math.max(right,b);else{excluded+=right-left;left=a;right=b;}}
 if(left!==null)excluded+=right-left;
 const internalSeconds=Math.max(0,(end-start-excluded)/1000),excludedSeconds=excluded/1000,allowedSeconds=input.allowedDays*86400;
 const state=reasons.length?'unrated':input.completedAt?'completed':internalSeconds>allowedSeconds?'overdue':internalSeconds>=allowedSeconds*input.warningRatio?'warning':'running';
 return {internalSeconds,excludedSeconds,allowedSeconds,state,precisionReasons:reasons,
  dueAt:reasons.length||open?null:new Date(start+allowedSeconds*1000+excluded).toISOString(),openExternal:open,
  onTime:input.completedAt&&!reasons.length?internalSeconds<=allowedSeconds:null} as const;
}
