import {useEffect,useRef,useState,type ReactNode} from 'react';
import {Button} from '@dx-rework/ui';
import type {DigitalSlaValue} from '@dx-rework/contracts/digital-sla';
import {trapCockpitDialogFocus} from './cockpit-dialog-focus.js';
import {slaDefaultUnit,slaScalar,slaUnitFactor,slaInputValue,readableSlaValue,type SlaInputUnit} from './sla-settings-draft.js';

export function SlaNodeEditDialog({label,value,current,source,readOnly=false,inline=false,disabled=false,keepDisabled=false,keepLabel='暂存到本次草稿',resetVersion=0,returnFocusTo,initialUnit,onInput,onCancel,onKeep,children}:{label:string;value:DigitalSlaValue;current:DigitalSlaValue;source:string;readOnly?:boolean;inline?:boolean;disabled?:boolean;keepDisabled?:boolean;keepLabel?:string;resetVersion?:number;returnFocusTo?:HTMLElement|null;initialUnit?:SlaInputUnit;onInput(value:DigitalSlaValue|null,error:string|null):void;onCancel():void;onKeep():void;children?:ReactNode}){
 const [unit,setUnit]=useState<SlaInputUnit>(initialUnit??slaDefaultUnit(value)),[raw,setRaw]=useState(()=>String(slaScalar(value)/slaUnitFactor(initialUnit??slaDefaultUnit(value)))),[error,setError]=useState<string|null>(null);
 const lastReset=useRef(resetVersion);useEffect(()=>{if(lastReset.current===resetVersion)return;lastReset.current=resetVersion;setRaw(String(slaScalar(value)/slaUnitFactor(unit)));setError(null);},[resetVersion,value,unit]);
 const dialog=useRef<HTMLDialogElement>(null),inlineEditor=useRef<HTMLElement>(null),close=useRef(onCancel);close.current=onCancel;
 useEffect(()=>{const node=dialog.current,prior=returnFocusTo??document.activeElement as HTMLElement|null;if(!inline&&node&&!node.open)node.showModal();if(inline)(inlineEditor.current?.querySelector<HTMLElement>('.sla-value-input input')??inlineEditor.current?.querySelector<HTMLElement>('button'))?.focus();return()=>{node?.close();if(prior?.isConnected)prior.focus();};},[inline,returnFocusTo]);
 const editable=!['unlimited','order_date'].includes(value.kind)&&!readOnly;
 const input=(text:string,nextUnit=unit)=>{setRaw(text);const checked=slaInputValue(text,nextUnit,value);setError(checked.error);onInput(checked.value,checked.error);};
 const content=<div>
  <header><h2>{inline?'选中节点：':readOnly?'查看':'调整'}{label}</h2><Button variant="secondary" disabled={disabled} aria-label={`关闭${label}编辑`} onClick={onCancel}>关闭</Button></header>
  <p className="cockpit-policy-baseline">现行值 {readableSlaValue(current)}{!inline&&<> · {source}</>}</p>{inline&&source&&<details className="sla-node-source"><summary>查看节点规则</summary>{source}</details>}
  {!editable?<p>{readableSlaValue(value)}</p>:<label className="sla-value-input">新值<input autoFocus={!inline} disabled={disabled} aria-label={`${label}数值`} inputMode="decimal" type="text" value={raw} onChange={event=>input(event.target.value)} aria-invalid={Boolean(error)}/>{'minutes'in value?<select disabled={disabled} aria-label={`${label}单位`} value={unit} onChange={event=>{const nextUnit=event.target.value as SlaInputUnit,checked=slaInputValue(raw,unit,value);if(!checked.value){setError('请先补齐有效数值，再切换单位');return;}setUnit(nextUnit);setRaw(String(slaScalar(checked.value)/slaUnitFactor(nextUnit)));setError(null);}}><option value="minutes">分钟</option><option value="hours">小时</option><option value="days-duration">天（24小时）</option></select>:<span>{value.kind==='ratio'?'%':'天'}</span>}</label>}
  {error&&<p role="alert">{label}：{error}</p>}{children}
  <p className="cockpit-policy-impact">{inline?'草稿尚未发布，在办订单不变。':'本次输入仅作草稿试算。暂存后仍须在页面预览并明确发布；不会改变已有订单。'}</p>
  <footer><Button variant="secondary" disabled={disabled} onClick={onCancel}>{readOnly?'关闭':'取消本项修改'}</Button>{editable&&<Button disabled={disabled||keepDisabled||Boolean(error)} onClick={onKeep}>{keepLabel}</Button>}</footer>
 </div>;
 return inline?<aside ref={inlineEditor} className="sla-node-edit-dialog sla-node-inline-editor" aria-label={`${readOnly?'查看':'调整'}${label}`} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();if(!disabled)onCancel();}}}>{content}</aside>:<dialog ref={dialog} className="cockpit-policy-dialog sla-node-edit-dialog" aria-label={`${readOnly?'查看':'调整'}${label}`} onKeyDown={trapCockpitDialogFocus} onCancel={event=>{event.preventDefault();if(!disabled)close.current();}}>{content}</dialog>;
}
