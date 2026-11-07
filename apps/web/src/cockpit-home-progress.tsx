import type {JourneyBusinessDate,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {CockpitDate} from './cockpit-date.js';

function HomeDate({value}:{value:JourneyBusinessDate|undefined}){
 return value?.status==='complete'&&value.at&&value.precision!=='unknown'
  ? <CockpitDate value={value.at} precision={value.precision} missing="—"/> : <span>—</span>;
}

/** Presentation only: never substitute old flat n/m or a plan percentage. */
export function CockpitHomeProgress({order}:{order:OrderJourney}){
 const progress=order.visualProgress;
 const meter=(label:string,ratio:number|null|undefined,key:string)=>{
  const known=ratio!==null&&ratio!==undefined&&Number.isFinite(ratio)&&ratio>=0&&ratio<=1;
  const percentage=known?ratio===1?100:Math.min(99.9,Math.round(ratio*1000)/10):undefined;
  return <div className="cockpit-home-progress-row" key={key}><span>{label}</span><span className="cockpit-home-progress-track" role="progressbar" aria-label={`${order.orderId?'整单':'开发'}${label}进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage} aria-valuetext={known?`${percentage}%`:'暂不可计算'} title={known?`${percentage}%`:'—'}>{known&&<i style={{width:`${ratio*100}%`}}/>}</span></div>;
 };
 const quantities=order.businessProgress?.quantities?.lines??[];
 const valid=quantities.length>0&&new Set(quantities.map(line=>line.lineId)).size===quantities.length&&quantities.every(line=>[line.demand,line.received,line.remainingReceipt].every(n=>Number.isSafeInteger(n)&&n>=0));
 const gap=valid?quantities.reduce((sum,line)=>sum+line.remainingReceipt,0):0;
 const full=valid&&quantities.length===order.lines.length&&order.lines.every(line=>quantities.some(row=>row.lineId===line.id&&row.demand===line.orderedQuantity));
 return <div className={`cockpit-home-progress is-${order.display?.mainState??'unknown'}`}>
  {meter('时间',progress?.timeRatio,'time')}{meter('实际',progress?.actualRatio,'actual')}
  <div className="cockpit-home-progress-dates"><small><span>预计完成</span><HomeDate value={progress?.expected}/></small><small><span>实际完成</span><HomeDate value={progress?.actual}/></small></div>
  {gap>0&&<strong className="cockpit-home-receipt-gap">{full?'':'可见范围'}欠收 {gap.toLocaleString()}件</strong>}
 </div>;
}
