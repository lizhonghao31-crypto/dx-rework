import type {DeliveryDay,DeliveryMonthResponse,DeliveryYearResponse,DeliveryRisk} from '@dx-rework/contracts/delivery-calendar';
import {deliveryMonthCells,deliveryDensityScale,deliveryQuantity,deliveryRiskLabels} from './delivery-calendar-model.js';

const weekdays=['一','二','三','四','五','六','日'];
const symbols:Record<DeliveryRisk,string>={delivered:'✓',overdue:'!',due_soon:'◷',pending:'·',unknown:'?'};
export const deliveryQtyText=(quantity:number|null)=>deliveryQuantity(quantity)+(quantity===null?'':'件');
const states=(day:DeliveryDay)=>Object.entries(day.states).filter((entry):entry is[DeliveryRisk,number]=>Boolean(entry[1]));
const dayLabel=(day:DeliveryDay)=>`${day.date}，${day.summary.poCount}个PO，应交${deliveryQtyText(day.summary.orderedQty)}，待交${deliveryQtyText(day.summary.pendingQty)}${states(day).map(([state,count])=>`，${deliveryRiskLabels[state]}${count}个PO`).join('')}`;
export function DeliveryStateMarks({day,words=false,compact=false}:{day:DeliveryDay;words?:boolean;compact?:boolean}){
 return <span className="delivery-state-marks">{states(day).slice(0,compact?2:undefined).map(([state,count])=><span key={state} className={'delivery-state is-'+state} title={`${deliveryRiskLabels[state]} ${count} PO`}><b aria-hidden="true">{symbols[state]}</b>{words&&<span>{deliveryRiskLabels[state]}</span>}<span className="delivery-sr-only">{deliveryRiskLabels[state]} {count} PO</span></span>)}{compact&&states(day).length>2&&<span className="delivery-state-extra" aria-hidden="true">+{states(day).length-2}</span>}</span>;
}
export function DeliveryStatusLegend(){return <span className="delivery-status-legend" aria-label="交付状态图例">{(['pending','delivered','due_soon','overdue','unknown']as const).map(state=><span key={state} className={'delivery-state is-'+state}><b aria-hidden="true">{symbols[state]}</b>{deliveryRiskLabels[state]}</span>)}</span>;}
export function DeliveryYearGrid({data,selectedDate,onMonth,onDay}:{data:DeliveryYearResponse;selectedDate:string;onMonth:(month:string)=>void;onDay:(date:string)=>void}){
 const scale=deliveryDensityScale(data.months.flatMap(month=>month.days));
 return <section className="delivery-year-overview" aria-label={`${data.year}年交付点阵`}>
  <header className="delivery-section-heading"><h2>交付点阵图（{data.year}年）</h2><div className="delivery-legends"><span className="delivery-density-legend">应交量密度{scale.maximum>0?<><i className="is-small"/>≤{scale.small}件{scale.medium>scale.small&&<><i className="is-medium"/>≤{scale.medium}件</>}{scale.maximum>scale.medium&&<><i className="is-large"/>&gt;{scale.medium}件</>}</>:<span>暂无已核数量</span>}</span><DeliveryStatusLegend/></div></header>
  <div className="delivery-year-months">{data.months.map(month=>{
   const byDate=new Map(month.days.map(day=>[day.date,day])),selected=selectedDate.startsWith(month.month);
   return <article key={month.month} className={'delivery-mini-month'+(selected?' is-selected':'')} aria-label={Number(month.month.slice(5))+'月交付'}>
    <button type="button" className="delivery-mini-heading" onClick={()=>onMonth(month.month)}><strong>{Number(month.month.slice(5))}月</strong><span>应交{deliveryQtyText(month.summary.orderedQty)}</span><span>待交{deliveryQtyText(month.summary.pendingQty)}</span></button>
    <div className="delivery-weekdays" aria-hidden="true">{weekdays.map(day=><span key={day}>{day}</span>)}</div>
    <div className="delivery-mini-days">{deliveryMonthCells(month.month).map((date,index)=>{
     if(!date)return <span key={'blank-'+index} aria-hidden="true"/>;
     const day=byDate.get(date)!,quantity=day.summary.orderedQty,density=quantity===null?'unknown':quantity===0?'empty':quantity<=scale.small?'small':quantity<=scale.medium?'medium':'large';
     return <button key={date} type="button" onClick={()=>onDay(date)} aria-label={dayLabel(day)} aria-current={date===data.asOfBusinessDate?'date':undefined} className={date===selectedDate?'is-selected':undefined}><span>{Number(date.slice(8))}</span>{day.summary.poCount>0&&<><i className={'delivery-density is-'+density} aria-hidden="true"/><DeliveryStateMarks day={day} compact/><span className="delivery-day-hint" role="tooltip">{dayLabel(day)}</span></>}</button>;
    })}</div>
   </article>;
  })}</div>
 </section>;
}
export function DeliveryMonthGrid({data,selectedDate,onSelect}:{data:DeliveryMonthResponse;selectedDate:string;onSelect:(date:string)=>void}){
 const byDate=new Map(data.days.map(day=>[day.date,day]));
 return <section className="delivery-month-panel dx-production-panel" aria-label={data.yearMonth+'交付月历'}>
  <div className="delivery-weekdays"><span>周一</span><span>周二</span><span>周三</span><span>周四</span><span>周五</span><span>周六</span><span>周日</span></div>
  <div className="delivery-month-days">{deliveryMonthCells(data.yearMonth).map((date,index)=>{
   if(!date)return <div className="delivery-month-blank" key={'blank-'+index} aria-hidden="true"/>;
   const day=byDate.get(date)!,present=day.summary.poCount>0;
   return <div className={'delivery-month-day'+(date===selectedDate?' is-selected':'')+(date===data.asOfBusinessDate?' is-today':'')} key={date}>
    <button type="button" className="delivery-day-select" onClick={()=>onSelect(date)} aria-label={dayLabel(day)} aria-pressed={date===selectedDate} aria-current={date===data.asOfBusinessDate?'date':undefined}><strong>{Number(date.slice(8))}</strong>{present&&<><span>应交 {deliveryQtyText(day.summary.orderedQty)}</span><span>待交 {deliveryQtyText(day.summary.pendingQty)}</span><DeliveryStateMarks day={day} words/></>}</button>
   </div>;
  })}</div>
 </section>;
}
