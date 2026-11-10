import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {addCalendarDays,isCalendarDate} from '@dx-rework/contracts/series-calendar';
import {PRODUCTION_STATISTICS_VERSION} from '@dx-rework/contracts/production-statistics';
import type {StatisticsCurrentResult,StatisticsFactoryResult,StatisticsMaterialRequirement,StatisticsMaterialResult,StatisticsMetric,StatisticsPo,StatisticsPoResult,StatisticsTime,StatisticsUnknown,StatisticsWindow,StatisticsWindowResult} from '@dx-rework/contracts/production-statistics';

const integer=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>=0;
const unique=<T>(values:T[])=>[...new Set(values)];
const metric=(unit:StatisticsMetric['unit']):StatisticsMetric=>({value:0,knownValue:0,unit,knownIds:[],unknown:[],excludedIds:[]});
const missing=(line:StatisticsPo,key:string,reason:string):StatisticsUnknown=>({key,orderId:line.orderId,lineId:line.lineId,reason,sourceRefs:line.quantitySourceRefs});
const unknownTime=():StatisticsTime=>({at:null,date:null,precision:'unknown',sourceRefs:[]});
const instant=(time:StatisticsTime)=>time.quality!=='unverified'&&time.precision==='instant'&&time.at&&time.sourceRefs.length&&Number.isFinite(Date.parse(time.at))?Date.parse(time.at):null;
const signature=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).filter(([key])=>key!=='sourceRefs').sort(([a],[b])=>a.localeCompare(b))):item);
function facts<T>(rows:T[],key:(row:T)=>string){
 const values=new Map<string,T>(),conflicts=new Set<string>();
 for(const row of rows){const id=key(row),previous=values.get(id);if(previous&&signature(previous)!==signature(row))conflicts.add(id);else values.set(id,row);}
 return {rows:[...values.values()],conflicts};
}
function add(result:StatisticsMetric,id:string,value:number|null,unknown:StatisticsUnknown[]=[]){
 if(value===null){result.value=null;result.unknown.push(...unknown);return;}
 result.knownValue+=value;if(result.value!==null)result.value+=value;result.knownIds.push(id);
}
/** Stable PO IDs are the grain, never task, receipt, source or textual PO joins. */
function poRows(input:StatisticsPo[]){
 const grouped=new Map<string,StatisticsPo[]>();for(const row of input){const group=grouped.get(row.lineId)??[];group.push(row);grouped.set(row.lineId,group);}
 return [...grouped.values()].map(group=>{
  const first=group[0]!,scalar=(line:StatisticsPo)=>signature({...line,quality:[],allocations:[],attributions:[],problems:[],windows:[],materials:[],reworks:[],workload:[]});
  const conflict=group.some(row=>scalar(row)!==scalar(first)),quality=facts(group.flatMap(row=>row.quality),row=>row.scopeId),allocations=facts(group.flatMap(row=>row.allocations).filter(row=>row.current),row=>row.scopeId);
  const history=facts(group.flatMap(row=>row.allocations).filter(row=>!row.current),row=>row.scopeId+':'+row.version),attributions=facts(group.flatMap(row=>row.attributions).filter(row=>row.current),row=>row.kind+':'+row.scopeId);
  const reworks=facts(group.flatMap(row=>row.reworks??[]),row=>row.reworkId),problems=facts(group.flatMap(row=>row.problems),row=>row.id),windows=facts(group.flatMap(row=>row.windows),row=>row.id+':'+row.version),materials=facts(group.flatMap(row=>row.materials),row=>row.requirementId+':'+row.scopeVersion);
  return {line:{...first,workload:facts(group.flatMap(row=>row.workload??[]),row=>row.id).rows,quality:quality.rows,allocations:[...allocations.rows,...history.rows],attributions:attributions.rows,problems:problems.rows.map(problem=>({...problem})),windows:windows.rows,materials:materials.rows,reworks:reworks.rows.map(rework=>reworks.conflicts.has(rework.reworkId)?{...rework,inputQuantity:null,processes:[],unknown:[...rework.unknown,'同一原返工范围的有效结果互相矛盾，不能选择其中一版签结果']}:rework)},conflict,qualityConflict:quality.conflicts.size>0,allocationConflict:allocations.conflicts.size>0,attributionConflicts:attributions.conflicts,otherConflicts:[...problems.conflicts,...windows.conflicts,...materials.conflicts,...reworks.conflicts]};
 });
}
function calculatePo(item:ReturnType<typeof poRows>[number]):StatisticsPoResult{
 const {line,conflict,qualityConflict,allocationConflict}=item,unknown:StatisticsUnknown[]=[],invalid=(key:string,reason:string)=>{unknown.push(missing(line,key,reason));return null;};
 const demand=!conflict&&integer(line.demand)?line.demand:invalid('demand',conflict?'同一PO有效事实或版本互相矛盾':'有效需求数量版本缺件');
 const received=!conflict&&integer(line.received)?line.received:invalid('received','本PO有效累计收货范围缺件或矛盾');
 const effectivePacking=line.effectivePacking===undefined?line.packing:line.effectivePacking;
 const packed=!conflict&&integer(effectivePacking)?effectivePacking:invalid('packed','本PO装箱与有效实收/合格范围尚未一致，不能当作有效出货');
 const remaining=demand!==null&&packed!==null?Math.max(demand-packed,0):invalid('remaining','有效需求或装箱范围不可判定');
 const excess=demand!==null&&packed!==null?Math.max(packed-demand,0):invalid('excess','有效需求或装箱范围不可判定');
 const inspections=line.quality.filter(row=>row.inspected),covered=inspections.reduce((n,row)=>n+row.quantity,0),qualified=inspections.reduce((n,row)=>n+row.qualified,0);
 const qualityValid=!qualityConflict&&received!==null&&inspections.every(row=>Boolean(row.quantityVersion)&&integer(row.quantity)&&integer(row.qualified)&&row.qualified<=row.quantity)&&covered<=received;
 const qualityCovered=qualityValid?covered:invalid('qualityCovered','当前到仓检查的范围/有效数量版本缺件或矛盾');
 const qualifiedQuantity=qualityValid?qualified:invalid('qualified','当前到仓检查的合格量不可判定');
 const qualityMissing=qualityValid?received!-covered:invalid('qualityMissing','当前到仓检查覆盖缺口不可判定');
 const physicalRemaining=demand!==null&&integer(line.packing)?Math.max(0,demand-line.packing):null;
 const allocations=line.allocations.filter(row=>row.current&&row.quantity!==0),allocated=allocations.reduce((n,row)=>n+row.quantity,0);
 const unallocated=!line.allocationComplete?invalid('unallocated','有效批准份额集合未完整读取'):demand===null||allocationConflict||allocations.some(row=>!integer(row.quantity)||!row.version)?invalid('unallocated','需求或当前有效批准份额版本冲突'):allocated>demand?invalid('unallocated','有效批准份额超配，不能截0掩盖'):line.specialClosure||physicalRemaining===0?0:physicalRemaining===null?invalid('unallocated','当前仍须生产的有效范围不可判定'):allocated===0?physicalRemaining:allocated===demand?0:line.packing===0?demand-allocated:invalid('unallocated','部分装箱与部分批准范围重叠关系未核，不能猜未覆盖生产量');
 if(line.lifecycle==='unknown')unknown.push(missing(line,'lifecycle','当前业务有效性缺件，不能认定普通数量完成'));
 for(const id of item.otherConflicts)unknown.push(missing(line,'fact-conflict','同一问题、窗口或物料范围版本存在矛盾：'+id));
 return {line:{...line,demand,received,packing:!conflict&&integer(line.packing)?line.packing:null,effectivePacking:packed},remaining,excess,qualityCovered,qualityMissing,qualified:qualifiedQuantity,quantityComplete:remaining===null||line.lifecycle==='unknown'?null:remaining===0,qualityComplete:qualityMissing===null?null:qualityMissing===0&&qualifiedQuantity===received,unallocated,unknown};
}
/** Amounts retain the requirement's own unit and approved scope version. */
export function materialStatistics(requirement:StatisticsMaterialRequirement):StatisticsMaterialResult{
 const result:StatisticsMaterialResult={requirement,state:'unknown',effectiveQuantity:null,knownEffectiveQuantity:0,first:unknownTime(),latest:unknownTime(),covered:unknownTime(),unknown:[]};
 if(requirement.applicability==='not-applicable'){result.state='not-applicable';return result;}
 const events=facts(requirement.events.filter(row=>row.scopeVersion===requirement.scopeVersion),row=>row.id);
 if(events.conflicts.size||events.rows.some(row=>!Number.isFinite(row.effectiveQuantity))){result.unknown.push('同一有效发料事实版本或数量矛盾');return result;}
 const quantity=events.rows.reduce((n,row)=>n+row.effectiveQuantity,0);if(quantity<0){result.unknown.push('有效发料退回量超过已发量');return result;}
 result.knownEffectiveQuantity=quantity;
 const positives=events.rows.filter(row=>row.effectiveQuantity>0),missingTime=positives.some(row=>instant(row.time)===null);
 if(missingTime)result.unknown.push('数量事实保留，但首次/最近发料业务时间未完整核实');
 else if(positives.length){const times=[...positives].sort((a,b)=>instant(a.time)!-instant(b.time)!);result.first=times[0]!.time;result.latest=times.at(-1)!.time;}
 if(!requirement.eventsComplete){result.first=unknownTime();result.latest=unknownTime();result.unknown.push(requirement.missingReason??'有效发料集合或历史逐PO数量未完整读取，已核小计不能冒完整量');return result;}
 result.effectiveQuantity=quantity;
 if(requirement.applicability==='unknown'||requirement.required===null||!Number.isFinite(requirement.required)||requirement.required<0){result.unknown.push('已核发出量保留；适用要求、单位数量或份额版本缺件，覆盖不可判定');return result;}
 result.state=quantity>=requirement.required?'complete':quantity===0?'not-sent':'partial';
 if(result.state==='complete'&&requirement.required>0){
  if(requirement.historyMatchesScope===false)result.unknown.push('当前数量覆盖已知，但需求/份额曾变化，历史发齐时间不能签当前范围');
  else if(events.rows.some(row=>instant(row.time)===null))result.unknown.push('发齐量已知，缺同需求版本的完整可信业务时间序列');
  else{let cumulative=0;for(const event of [...events.rows].sort((a,b)=>instant(a.time)!-instant(b.time)!||a.id.localeCompare(b.id))){cumulative+=event.effectiveQuantity;if(cumulative>=requirement.required){result.covered=event.time;break;}}}
 }
 return result;
}
export function windowStatistics(window:StatisticsWindow,asOf:string):StatisticsWindowResult{
 const now=Date.parse(asOf);if(!Number.isFinite(now))throw Error('Explicit window observation required');
 const entered=instant(window.entered),completed=instant(window.completed),deadline=window.deadline&&Number.isFinite(Date.parse(window.deadline))?Date.parse(window.deadline):null;
 const result:StatisticsWindowResult={window,due:null,onTime:null,completedSeconds:null,unfinishedAgeSeconds:null,knownWaitingSeconds:0,waitingCoverage:window.waitingCoverage,unknown:[]};
 if(window.excludedReason||window.state==='cancelled')return result;
 const end=window.state==='completed'?completed:now;
 if(entered===null||end===null||end<entered||end>now)result.unknown.push('可信实际进入/完成时刻缺件或倒序，不以创建时间补齐');
 else if(window.state==='completed')result.completedSeconds=(end-entered)/1000;else result.unfinishedAgeSeconds=(end-entered)/1000;
 if(window.independent){if(deadline===null)result.unknown.push('独立责任窗口缺适用截止');else{result.due=deadline<=now;if(result.due)result.onTime=window.state==='completed'?completed===null||completed>now||entered!==null&&completed<entered?null:window.deadlineExclusive?completed<deadline:completed<=deadline:false;}}
 const waits=facts(window.waits,row=>row.id),intervals:Array<[number,number]>=[];
 for(const wait of waits.rows.filter(wait=>!waits.conflicts.has(wait.id))){const from=Date.parse(wait.from),to=wait.to===null?now:Date.parse(wait.to);if(!wait.verified||!Number.isFinite(from)||!Number.isFinite(to)||to<from||entered===null||end===null){result.waitingCoverage='partial';result.unknown.push('等待区间缺证或不可定位到同一责任窗口');continue;}const lo=Math.max(from,entered),hi=Math.min(to,end);if(hi>lo)intervals.push([lo,hi]);}
 if(waits.conflicts.size){result.waitingCoverage='partial';result.unknown.push('同一等待范围存在矛盾版本');}
 intervals.sort((a,b)=>a[0]-b[0]);let lo:number|null=null,hi=0;for(const [from,to] of intervals){if(lo===null){lo=from;hi=to;}else if(from<=hi)hi=Math.max(hi,to);else{result.knownWaitingSeconds+=(hi-lo)/1000;lo=from;hi=to;}}if(lo!==null)result.knownWaitingSeconds+=(hi-lo)/1000;
 return result;
}
/** Inputs must already be authorized and share one explicit business observation. */
export function currentProductionStatistics(input:StatisticsPo[],asOf:string,businessDate:string):StatisticsCurrentResult{
 if(!Number.isFinite(Date.parse(asOf))||!isCalendarDate(businessDate)||beijingCalendarDate(new Date(asOf))!==businessDate)throw Error('Explicit valid business observation and Beijing date required');
 const metrics:StatisticsCurrentResult['metrics']={orders:metric('母单'),pos:metric('PO'),demand:metric('件'),received:metric('件'),qualityCovered:metric('件'),qualified:metric('件'),qualityMissing:metric('件'),packed:metric('件'),remaining:metric('件'),excess:metric('件'),completedOrders:metric('母单'),completedPos:metric('PO'),unallocated:metric('件'),duePos:metric('PO'),dueQuantity:metric('件'),nextSevenPos:metric('PO'),nextSevenQuantity:metric('件'),missingCustomerDatePos:metric('PO'),blockedPos:metric('PO'),blockedOrders:metric('母单'),currentProblems:metric('问题'),cancelledOrders:metric('母单'),specialClosureOrders:metric('母单')};
 const items=poRows(input),rows=items.map(calculatePo),toExclusive=addCalendarDays(businessDate,7);
 for(const id of unique(rows.map(row=>row.line.orderId))){
  add(metrics.orders,id,1);const orderRows=rows.filter(row=>row.line.orderId===id),applicable=orderRows.filter(row=>row.line.lifecycle!=='cancelled');
  if(!applicable.length){add(metrics.cancelledOrders,id,1);metrics.completedOrders.excludedIds.push(id);}
  else if(applicable.some(row=>row.line.specialClosure)){add(metrics.specialClosureOrders,id,1);metrics.completedOrders.excludedIds.push(id);}
  else if(applicable.every(row=>row.quantityComplete===true))add(metrics.completedOrders,id,1);
  else if(applicable.some(row=>row.quantityComplete===null))add(metrics.completedOrders,id,null,applicable.flatMap(row=>row.unknown));
 }
 for(const row of rows){const line=row.line,id=line.lineId;add(metrics.pos,id,1);
  if(line.lifecycle==='cancelled'){for(const key of Object.keys(metrics) as Array<keyof typeof metrics>)if(!['orders','pos','cancelledOrders','specialClosureOrders','currentProblems'].includes(key)){const excludedId=metrics[key].unit==='母单'?line.orderId:id;if(!metrics[key].excludedIds.includes(excludedId))metrics[key].excludedIds.push(excludedId);}continue;}
  for(const [key,value] of Object.entries({demand:line.demand,received:line.received,qualityCovered:row.qualityCovered,qualified:row.qualified,qualityMissing:row.qualityMissing,packed:line.effectivePacking===undefined?line.packing:line.effectivePacking,remaining:row.remaining,excess:row.excess,unallocated:row.unallocated}) as Array<[keyof typeof metrics,number|null]>)add(metrics[key],id,value,row.unknown.filter(reason=>reason.key===key));
  if(line.specialClosure)metrics.completedPos.excludedIds.push(id);else if(row.quantityComplete===true)add(metrics.completedPos,id,1);else if(row.quantityComplete===null)add(metrics.completedPos,id,null,row.unknown);
  if(!line.customerDate||!isCalendarDate(line.customerDate))add(metrics.missingCustomerDatePos,id,1);
  else{const due=line.customerDate<businessDate,next=line.customerDate>=businessDate&&line.customerDate<toExclusive;if(row.remaining===null){if(due){add(metrics.duePos,id,null,row.unknown);add(metrics.dueQuantity,id,null,row.unknown);}if(next){add(metrics.nextSevenPos,id,null,row.unknown);add(metrics.nextSevenQuantity,id,null,row.unknown);}}else if(row.remaining>0){if(due){add(metrics.duePos,id,1);add(metrics.dueQuantity,id,row.remaining);}if(next){add(metrics.nextSevenPos,id,1);add(metrics.nextSevenQuantity,id,row.remaining);}}}
 }
 const unattributed:StatisticsCurrentResult['unattributed']=[];
 for(const row of rows.filter(row=>row.line.lifecycle!=='cancelled'))for(const kind of ['received','qualified','packed'] as const){
  const total=kind==='received'?row.line.received:kind==='qualified'?row.qualified:row.line.packing,range=row.line.attributions.filter(fact=>fact.kind===kind),item=items.find(item=>item.line.lineId===row.line.lineId)!;
  const valid=!range.some(fact=>!integer(fact.quantity)||!fact.quantityVersion)&&![...item.attributionConflicts].some(key=>key.startsWith(kind+':')),known=range.filter(fact=>fact.factoryId!==null).reduce((n,fact)=>n+fact.quantity,0);
  const quantity=valid&&total!==null&&known<=total&&range.reduce((n,fact)=>n+fact.quantity,0)<=total?total-known:null;if(quantity===null||quantity>0)unattributed.push({orderId:row.line.orderId,lineId:row.line.lineId,kind,quantity,reason:quantity===null?'归属事实、有效版本或数量矛盾，不能分摊到工厂':'该范围尚无完整可信工厂归属，保留全局一次'});
 }
 const factories:StatisticsFactoryResult[]=[];
 for(const factoryId of unique(rows.flatMap(row=>row.line.allocations.map(scope=>scope.factoryId)))){
  const involved=rows.filter(row=>row.line.allocations.some(scope=>scope.factoryId===factoryId)),current=involved.filter(row=>row.line.lifecycle!=='cancelled'&&row.line.allocations.some(scope=>scope.factoryId===factoryId&&scope.current&&scope.quantity>0));
  const scopes=involved.flatMap(row=>row.line.allocations.filter(scope=>scope.factoryId===factoryId)),knownAttributed={received:0,qualified:0,packed:0},attributionUnknown:StatisticsUnknown[]=[];
  const allocationValid=current.every(row=>{const item=items.find(item=>item.line.lineId===row.line.lineId)!;return row.line.allocationComplete&&!item.allocationConflict&&integer(row.line.demand)&&row.line.allocations.filter(scope=>scope.current).every(scope=>integer(scope.quantity)&&Boolean(scope.version))&&row.line.allocations.filter(scope=>scope.current).reduce((n,scope)=>n+scope.quantity,0)<=row.line.demand;}),allocated=allocationValid?current.flatMap(row=>row.line.allocations.filter(scope=>scope.current&&scope.factoryId===factoryId)).reduce((n,scope)=>n+scope.quantity,0):null;
  for(const row of current)for(const kind of ['received','qualified','packed'] as const){const item=items.find(item=>item.line.lineId===row.line.lineId)!;knownAttributed[kind]+=row.line.attributions.filter(fact=>fact.kind===kind&&fact.factoryId===factoryId&&integer(fact.quantity)&&fact.quantityVersion&&!item.attributionConflicts.has(kind+':'+fact.scopeId)).reduce((n,fact)=>n+fact.quantity,0);if(unattributed.some(pool=>pool.lineId===row.line.lineId&&pool.kind===kind))attributionUnknown.push(missing(row.line,'factory-'+kind,'该PO此项归厂范围不完整，已核归属量不等于本厂真实量或欠量'));}
  const actual={received:!current.length||attributionUnknown.some(row=>row.key==='factory-received')?null:knownAttributed.received,qualified:!current.length||attributionUnknown.some(row=>row.key==='factory-qualified')?null:knownAttributed.qualified,packed:!current.length||attributionUnknown.some(row=>row.key==='factory-packed')?null:knownAttributed.packed};
  if(current.length)attributionUnknown.push(missing(current[0]!.line,'factory-remaining','未核本厂责任终点及适用交货版本，不以客户待装箱量冒工厂欠交'));
  const sum=(select:(row:StatisticsPoResult)=>number|null)=>current.some(row=>select(row)===null)?null:current.reduce((n,row)=>n+select(row)!,0);
  factories.push({factoryId,factoryName:scopes[0]!.factoryName,orderIds:unique(current.map(row=>row.line.orderId)),lineIds:current.map(row=>row.line.lineId),nonAdditiveEntityCounts:true,allocated,involvedPoDemand:sum(row=>row.line.demand),involvedPoCustomerRemaining:sum(row=>row.remaining),knownAttributed,actual,remaining:null,attributionUnknown,historicalOnly:current.length===0,excludedReason:current.length===0?'当前有效份额为0，仅保留历史范围，不参加当前生产分母':null});
 }
 const materialRows=facts(rows.flatMap(row=>row.line.materials),row=>row.requirementId+':'+row.scopeVersion),windowRows=facts(rows.flatMap(row=>row.line.windows),row=>row.id+':'+row.version),problemRows=facts(rows.flatMap(row=>row.line.problems),row=>row.id);
 for(const row of rows)if(row.line.demand!==null&&row.line.packing!==null&&row.line.packing>=row.line.demand&&row.qualityMissing!==null&&row.qualityMissing>0){const id=`packed-quality-gap:${row.line.lineId}:${row.line.quantityVersion}:${row.line.packingRevision??'none'}`;problemRows.rows.push({id,orderId:row.line.orderId,lineIds:[row.line.lineId],kind:'已装齐的到仓检查仍有缺口',blocking:false,reasonCode:null,description:`本PO已装齐，但到仓检查尚缺${row.qualityMissing}件覆盖`,state:'current',occurred:unknownTime(),observed:unknownTime(),recorded:unknownTime(),resolved:unknownTime(),recurrenceOf:null,sourceRefs:row.line.quantitySourceRefs});}
 for(const row of rows)if(row.line.packing!==null&&row.qualified!==null&&row.line.packing>row.qualified&&row.qualityMissing===0){const id=`packed-qualified-gap:${row.line.lineId}:${row.line.quantityVersion}:${row.line.packingRevision??'none'}`;problemRows.rows.push({id,orderId:row.line.orderId,lineIds:[row.line.lineId],kind:'装箱数量超过已核合格数量',blocking:false,reasonCode:null,description:`原装箱${row.line.packing}件，当前已核合格${row.qualified}件，交付仍待核`,state:'current',occurred:unknownTime(),observed:unknownTime(),recorded:unknownTime(),resolved:unknownTime(),recurrenceOf:null,sourceRefs:row.line.quantitySourceRefs});}
 const factUnknown:StatisticsUnknown[]=[],currentOrderIds=new Set(rows.filter(row=>row.line.lifecycle!=='cancelled').map(row=>row.line.orderId));
 for(const id of materialRows.conflicts){const material=materialRows.rows.find(row=>row.requirementId+':'+row.scopeVersion===id)!;factUnknown.push({key:'material-conflict',orderId:rows.find(row=>row.line.materials.includes(material))?.line.orderId??'',lineId:material.lineId,reason:'同一物料要求及版本存在矛盾，不能选择其中一版签覆盖',sourceRefs:material.sourceRefs});}
 for(const id of windowRows.conflicts){const window=windowRows.rows.find(row=>row.id+':'+row.version===id)!;factUnknown.push({key:'window-conflict',orderId:window.orderId,lineId:null,reason:'同一责任窗口版本存在矛盾，本窗到期和周期均不可判定',sourceRefs:window.sourceRefs});}
 for(const id of problemRows.conflicts){const problem=problemRows.rows.find(row=>row.id===id)!;problem.state='unknown';factUnknown.push({key:'problem-conflict',orderId:problem.orderId,lineId:null,reason:'同一问题生命周期证据互相矛盾，保留未知，不能按任意一版认定当前或解决',sourceRefs:problem.sourceRefs});if(currentOrderIds.has(problem.orderId))add(metrics.currentProblems,id,null,factUnknown.slice(-1));}
 for(const problem of problemRows.rows.filter(problem=>!currentOrderIds.has(problem.orderId)))metrics.currentProblems.excludedIds.push(problem.id);
 for(const problem of problemRows.rows.filter(problem=>problem.state==='unknown'&&!problemRows.conflicts.has(problem.id)&&currentOrderIds.has(problem.orderId))){const reason={key:'problem-lifecycle',orderId:problem.orderId,lineId:null,reason:'原问题缺明确解决或当前状态证据，不能当作当前0条',sourceRefs:problem.sourceRefs};factUnknown.push(reason);add(metrics.currentProblems,problem.id,null,[reason]);}
 const activeProblems=problemRows.rows.filter(problem=>problem.state==='current'&&currentOrderIds.has(problem.orderId));for(const problem of activeProblems)add(metrics.currentProblems,problem.id,1);
 for(const orderId of unique(activeProblems.filter(problem=>problem.blocking).map(problem=>problem.orderId)))add(metrics.blockedOrders,orderId,1);
 const blockedLineIds=unique(activeProblems.filter(problem=>problem.blocking).flatMap(problem=>problem.lineIds)).filter(id=>rows.some(row=>row.line.lineId===id&&row.line.lifecycle!=='cancelled'));for(const id of blockedLineIds)add(metrics.blockedPos,id,1);
 for(const problem of problemRows.rows.filter(problem=>problem.state==='unknown'&&problem.blocking&&currentOrderIds.has(problem.orderId))){const reason={key:'blocked',orderId:problem.orderId,lineId:null,reason:'原阻断问题当前或解决状态不可判定，不能选择任意一版或按0计数',sourceRefs:problem.sourceRefs};if(!metrics.blockedOrders.knownIds.includes(problem.orderId))add(metrics.blockedOrders,problem.orderId,null,[reason]);if(!problem.lineIds.length)add(metrics.blockedPos,problem.id,null,[reason]);for(const lineId of problem.lineIds)if(!metrics.blockedPos.knownIds.includes(lineId))add(metrics.blockedPos,lineId,null,[{...reason,lineId}]);}
 for(const problem of activeProblems.filter(problem=>problem.blocking&&!problem.lineIds.length)){add(metrics.blockedPos,problem.id,null,[{key:'blockedPos',orderId:problem.orderId,lineId:null,reason:'原母单阻断已知，但尚未核明受影响PO范围，不能把涉及PO数当0或全单',sourceRefs:problem.sourceRefs}]);}

 return {ruleVersion:PRODUCTION_STATISTICS_VERSION,asOf,businessDate,timezone:'Asia/Shanghai',sevenDayWindow:{fromInclusive:businessDate,toExclusive},metrics,rows,factories,unattributed,materials:materialRows.rows.map(material=>materialRows.conflicts.has(material.requirementId+':'+material.scopeVersion)?{requirement:material,state:'unknown',effectiveQuantity:null,knownEffectiveQuantity:0,first:unknownTime(),latest:unknownTime(),covered:unknownTime(),unknown:['同一需求范围版本冲突，不能选择一版计算']}:materialStatistics(material)),windows:windowRows.rows.map(window=>windowRows.conflicts.has(window.id+':'+window.version)?{window,due:null,onTime:null,completedSeconds:null,unfinishedAgeSeconds:null,knownWaitingSeconds:0,waitingCoverage:'unknown',unknown:['同一责任窗口版本冲突，不能选择一版计算']}:windowStatistics(window,asOf)),problems:problemRows.rows,reworks:facts(rows.flatMap(row=>row.line.reworks??[]),row=>row.reworkId).rows,workload:facts(rows.flatMap(row=>row.line.workload??[]),row=>row.id).rows,unknown:[...rows.flatMap(row=>row.unknown),...factUnknown]};
}
