import {Button} from '@dx-rework/ui';
import {useState} from 'react';
import type {BulkMaterialsDispatch,BulkPreparationSheet} from '@dx-rework/contracts/bulk-preparation';
import {Selector} from '@astryxdesign/core/Selector';
import {TextInput} from '@astryxdesign/core/TextInput';
import {designerAstryxCss} from './designer-astryx.js';
export function BulkMaterialsPanel({sheet,busy,readonly,save,initiallyOpen=false}:{
 sheet:BulkPreparationSheet;busy:boolean;readonly:boolean;save:(path:string,input:unknown)=>Promise<boolean>;initiallyOpen?:boolean;
}){
 const [selected,setSelected]=useState<Record<string,string>>({});
 const [inputs,setInputs]=useState<Record<string,string>>({}),[error,setError]=useState<string|null>(null);
 const m=sheet.materials;if(!m||!m.items.length&&!m.history.length)return null;
 const lotKey=(id:string,ref:{recordId:string;version:number;quantityRowKey?:string|undefined})=>JSON.stringify([id,ref.recordId,ref.version,ref.quantityRowKey??null]);
 const optionKey=(item:{lineId:string|null;scopeRef:string})=>JSON.stringify([item.lineId,item.scopeRef]);
 const selectedScope=(item:typeof m.items[number])=>item.issueOptions?.find(option=>optionKey(option)===selected[item.id])??(item.issueOptions?.length===1?item.issueOptions[0]:undefined);
 const hasBoundLots=m.items.some(item=>item.issueOptions!==undefined);
 const materialLabel=m.items.some(item=>item.kind==='fabric')?'面辅料':'辅料';
 return <details open={initiallyOpen||undefined} className={`bulk-fabric-panel${hasBoundLots?' dx-designer-astryx':''}`}><summary>{materialLabel}发出记录 · {m.history.length} 次</summary>
 {hasBoundLots&&<style>{designerAstryxCss}</style>}<p>当前加工厂：{m.supplierName??'待批准'}。发出不代表工厂已收到。</p>
 {error&&<p role="alert">{error}</p>}
 {m.canDispatch&&!readonly&&<form onSubmit={e=>{
  e.preventDefault();const f=new FormData(e.currentTarget);let badQuantity=false;
  const items:BulkMaterialsDispatch['items']=m.items.flatMap(i=>{
   if(!i.issueOptions)return Number(f.get(i.id))>0?[{materialId:i.id,quantity:Number(f.get(i.id)),unit:String(f.get(`unit:${i.id}`)??'')}]:[];
   const option=selectedScope(i);if(!option)return [];
   const allocations=option.lots.flatMap(lot=>{
    const input=inputs[lotKey(i.id,lot.receipt)]?.trim()??'';
    if(input&&!/^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,6})?$/.test(input))badQuantity=true;
    return Number(input)>0?[{receipt:lot.receipt,quantity:input}]:[];
   });
   if(!allocations.length)return [];
   const quantity=allocations.reduce((sum,lot)=>sum+Math.round(Number(lot.quantity)*1_000_000),0)/1_000_000;
   return [{materialId:i.id,quantity,unit:option.unit,scope:{scopeRef:option.scopeRef,lineId:option.lineId,allocations}}];
  });
  if(badQuantity){setError('请填写正确的实际发出数量，最多六位小数。');return;}
  setError(null);
  void save('/materials-dispatch',{instructionVersion:m.instructionVersion,supplierId:m.supplierId,occurredAt:new Date(`${String(f.get('at'))}+08:00`).toISOString(),note:String(f.get('note')??''),items})
   .then(saved=>{if(saved)setInputs({});});
 }}><fieldset disabled={busy}><legend>本次实际发出</legend>{m.items.map(i=>{
  if(!i.issueOptions)return <div key={i.id} className="bulk-fabric-fields"><label>{i.name} · {i.materialColor} · {i.specification}<input type="number" name={i.id} min="0" step="any" defaultValue="0"/></label><label>单位<input name={`unit:${i.id}`} maxLength={20}/></label></div>;
  const option=selectedScope(i);
  return <div key={i.id} className="bulk-fabric-fields"><span>{i.name} · {i.materialColor} · {i.specification}</span>
   {!i.issueOptions.length&&<small>有效收料批次或采用数量待核，暂不能发出。</small>}
   {i.issueOptions.length>1&&<Selector label={`${i.name} 发料范围`} value={option?optionKey(option):''} options={i.issueOptions.map(row=>({value:optionKey(row),label:row.poLabel}))}
    onChange={value=>setSelected(current=>({...current,[i.id]:value}))} isDisabled={busy}/>}
   {option&&<div key={optionKey(option)}><small>{option.poLabel} · 采用需用 {option.required} {option.unit} · 本范围可发 {option.remaining} {option.unit}</small>
    {option.lots.filter(lot=>Number(lot.remaining.quantity)>0).map((lot,index)=>{const key=lotKey(i.id,lot.receipt);return <TextInput key={key}
     label={`${lot.receipt.quantityRowKey?`原收布明细 ${index+1}`:`第 ${lot.receipt.version} 批`}实际发出（${option.unit}，本批可用 ${lot.remaining.quantity}）`} inputMode="decimal" value={inputs[key]??''}
     isDisabled={busy||option.remaining==='0'} onChange={value=>setInputs(current=>({...current,[key]:value}))}/>;})}
   </div>}
  </div>;
 })}<label>实际时间（北京时间）<input name="at" type="datetime-local" required/></label><label>说明<textarea name="note" maxLength={1000} rows={2}/></label><Button type="submit">保存{materialLabel}发出</Button></fieldset></form>}
 {m.history.map(h=><p key={h.eventId}>{new Date(h.occurredAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} · {h.operatorName} · {h.items.map(i=>`${i.name} ${i.quantity}${i.unit}`).join('；')} {h.note}</p>)}
 </details>;
}
