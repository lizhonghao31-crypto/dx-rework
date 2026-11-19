import {naturalTimeRatio} from '@dx-rework/domain';
import {useScheduleObservation} from './cockpit-fixed-schedule.js';
import type {JourneyBusinessDate,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {CockpitDate} from './cockpit-date.js';

function HomeDate({value,missing='—'}:{value:JourneyBusinessDate|undefined;missing?:string}){
 return value?.status==='complete'&&value.at&&value.precision!=='unknown'
  ? <CockpitDate value={value.at} precision={value.precision} missing="—" short/> : <span>{missing}</span>;
}

/** Completion forecast is derived from all authorized PO estimates, never B/H. */
export function CockpitCompletionEstimate({order}:{order:OrderJourney}){
 if(!order.fixedSchedule)return <HomeDate value={order.visualProgress?.expected}/>;
 const scopes=order.fixedSchedule?.scopes??[];
 if(!scopes.length)return <span>—</span>;
 const estimates=scopes.map(scope=>scope.completionEstimate);
 if(estimates.some(value=>!value||['unknown','terminated'].includes(value.kind)||!value.earliest))return <span>—</span>;
 const earliest=estimates.map(value=>value!.earliest!).sort().at(-1)!;
 const bounded=estimates.some(value=>value!.kind==='lower_bound'||!value!.latest);
 const latest=bounded?null:estimates.map(value=>value!.latest!).sort().at(-1)!;
 return <span>{bounded&&'不早于'}<CockpitDate value={earliest} precision="instant" short/>{latest&&latest!==earliest&&<>～<CockpitDate value={latest} precision="instant" short/></>}</span>;
}

/** Quantity remains a separate native fact, never a progress percentage. */
export function cockpitReceiptGap(order:OrderJourney){
 const quantities=order.businessProgress?.quantities?.lines??[];
 const valid=quantities.length>0&&new Set(quantities.map(line=>line.lineId)).size===quantities.length&&quantities.every(line=>order.lines.some(visible=>visible.id===line.lineId)&&[line.demand,line.received,line.remainingReceipt].every(n=>Number.isSafeInteger(n)&&n>=0));
 if(!valid)return null;
 return {gap:quantities.reduce((sum,line)=>sum+line.remainingReceipt,0),full:quantities.length===order.lines.length&&order.lines.every(line=>quantities.some(row=>row.lineId===line.id&&row.demand===line.orderedQuantity))};
}

/** Presentation only: never substitute old flat n/m or a plan percentage. */
export function CockpitHomeProgress({order}:{order:OrderJourney}){
 const progress=order.visualProgress,observed=useScheduleObservation(order);
 const stopped=['completed','closed','cancelled'].includes(order.display?.mainState??'');
 const ratio=progress?.delivery&&observed&&!stopped?naturalTimeRatio(progress.startedAt,progress.delivery,observed):progress?.timeRatio;
 const meter=(label:string,ratio:number|null|undefined,key:string)=>{
  const known=ratio!==null&&ratio!==undefined&&Number.isFinite(ratio)&&ratio>=0&&ratio<=1;
  const percentage=known?ratio===1?100:Math.min(99.9,Math.round(ratio*1000)/10):undefined;
  return <div className="cockpit-home-progress-row" data-progress-kind={key} key={key}><span className="cockpit-home-progress-label">{label&&label+' '}{known?`${percentage}%`:'—'}</span><span className="cockpit-home-progress-track" role="progressbar" aria-label={`${order.orderId?'整单':'开发'}${key==='time'?'自然时间进度':'实际进度'}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage} aria-valuetext={known?`${percentage}%`:'暂不可计算'} title={known?`${percentage}%`:'暂不可计算'}>{known?<i style={{width:`${ratio*100}%`}}/>:<span className="cockpit-home-progress-unknown" aria-hidden="true">—</span>}</span></div>;
 };
 const dates=order.fixedSchedule?.framework?.scopes.map(scope=>scope.customerDate)??order.poDeliveryDates?.map(line=>line.customerWarehouseArrivalDate)??[];
 const complete=dates.length>0&&dates.length===order.lines.length&&dates.every(date=>Boolean(date)),unique=[...new Set(dates.filter((date):date is string=>Boolean(date)))].sort();
 return <div className={`cockpit-home-progress is-${order.display?.mainState??'unknown'}`}>
  <div className="cockpit-home-delivery-date">{unique.map(date=><CockpitDate key={date} value={date} precision="date" short/>)}{!complete&&<span>{unique.length?'部分日期待核':'—'}</span>}</div>
  {meter('',ratio,'time')}
  {meter('实际进度',progress?.actualRatio,'actual')}
  {order.display?.mainState==='completed'&&<small className="cockpit-home-completed-date">实际完成 <HomeDate value={progress?.actual} missing="完成时间待核"/></small>}
 </div>;
}
