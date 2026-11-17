import {useEffect,useState} from 'react';
import type {OrderTimeCheckResult} from '@dx-rework/contracts/order-time-requests';
import type {OrderTimeWashingReworkChanges} from '@dx-rework/contracts/order-time-washing-rework';
import {createClientRequestId} from './client-request-id.js';

export function OrderTimeRewashFields({rows,value,disabled,onChange,onInvalid}:{rows:NonNullable<OrderTimeCheckResult['rewashing']>;value:OrderTimeWashingReworkChanges;disabled:boolean;onChange(next:OrderTimeWashingReworkChanges):void;onInvalid(invalid:boolean):void}){
 const [quantities,setQuantities]=useState<Record<string,string>>({});
 const forgetQuantity=(key:string)=>setQuantities(before=>{const next={...before};delete next[key];return next;});
 const invalidDraft=(draft:OrderTimeWashingReworkChanges,texts:Record<string,string>)=>draft.some(item=>{
  const row=rows.find(row=>row.scopeId===item.scopeId&&row.inspectionId===item.inspectionId&&row.lineId===item.lineId&&row.quantityVersion===item.quantityVersion);
  if(!row)return true;
  const raw=texts[item.scopeId+'|'+item.inspectionId]??String(item.quantity),quantity=Number(raw);
  return !/^\d+$/.test(raw)||!Number.isSafeInteger(quantity)||quantity<=0||quantity>row.availableQuantity;
 });
 useEffect(()=>{onInvalid(invalidDraft(value,quantities));},[rows,value,quantities,onInvalid]);
 const stale=value.filter(item=>!rows.some(row=>row.scopeId===item.scopeId&&row.inspectionId===item.inspectionId&&row.lineId===item.lineId&&row.quantityVersion===item.quantityVersion));
 return <details className="r5-time-washing"><summary>新增返洗计划</summary><p>只安排选中的真实不合格范围；原计划和已开始责任保留。本次新增返洗须单独提交，不与其他用时调整混在一起。</p>{stale.map(item=><p role="alert" key={item.intentId}>已选返洗范围已变化，草稿仍保留。<button type="button" disabled={disabled} onClick={()=>{const next=value.filter(row=>row.intentId!==item.intentId);forgetQuantity(item.scopeId+'|'+item.inspectionId);onInvalid(invalidDraft(next,quantities));onChange(next);}}>移除失效范围</button></p>)}{rows.length===0&&<p>当前没有尚可新增安排的返洗范围。</p>}{rows.map(row=>{
  const key=row.scopeId+'|'+row.inspectionId,selected=value.find(item=>item.scopeId===row.scopeId&&item.inspectionId===row.inspectionId&&item.lineId===row.lineId&&item.quantityVersion===row.quantityVersion),text=quantities[key]??String(selected?.quantity??row.availableQuantity);
  const update=(checked:boolean,nextText=text)=>{
   if(!checked)forgetQuantity(key);
   const quantity=Number(nextText),invalid=checked&&(!/^\d+$/.test(nextText)||!Number.isSafeInteger(quantity)||quantity<=0||quantity>row.availableQuantity);
   const rest=value.filter(item=>item.scopeId!==row.scopeId||item.inspectionId!==row.inspectionId);
   const next=invalid?value:checked?[...rest,{intentId:selected?.intentId??createClientRequestId(),lineId:row.lineId,scopeId:row.scopeId,quantityVersion:row.quantityVersion,inspectionId:row.inspectionId,quantity}]:rest;
   const invalidAny=invalid||invalidDraft(next,{...quantities,[key]:nextText});
   onInvalid(invalidAny);if(!invalid)onChange(next);
  };
  return <fieldset key={key} disabled={disabled}><legend>{row.label} · 第{row.round}轮返洗</legend><label><input type="checkbox" checked={Boolean(selected)} onChange={event=>update(event.target.checked)}/>安排本次返洗</label>
   <label>本次计划数量<input type="number" min="1" max={row.availableQuantity} value={text} disabled={disabled||!selected} onChange={event=>{setQuantities(before=>({...before,[key]:event.target.value}));update(true,event.target.value);}}/></label>
   <p>尚可安排 {row.availableQuantity} 件 · 洗水 {row.washingMinutes/60} 小时 · 检查 {row.inspectionMinutes/60} 小时，沿原采用日历。</p>
   {!row.inspectionAt&&<p role="status">原不合格检查时间待核，不能补造计划起点。</p>}
  </fieldset>;
 })}</details>;
}
