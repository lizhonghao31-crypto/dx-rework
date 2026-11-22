import {useEffect,useRef,useState} from 'react';
import {Button} from '@dx-rework/ui';
import type {DevelopmentMaterialEvent} from '@dx-rework/contracts/digital-development';
import {DevelopmentOccurrenceInput,developmentTimeFromForm} from './development-occurrence-input.js';

export function DevelopmentAccessoryForecastForm({busy,round,version,revision,expectedDate,onSubmit}:{busy:boolean;round:number;version:number;revision:number;expectedDate:string|null;onSubmit:(input:DevelopmentMaterialEvent)=>Promise<boolean>}){
 const [open,setOpen]=useState(false);
 const trigger=useRef<HTMLSpanElement>(null),restoreFocus=useRef(false);
 useEffect(()=>{if(!open&&!busy&&restoreFocus.current){restoreFocus.current=false;trigger.current?.querySelector('button')?.focus();}},[open,busy]);
 const close=()=>{restoreFocus.current=true;setOpen(false);};
 if(!open)return <span ref={trigger}><Button type="button" disabled={busy} onClick={()=>setOpen(true)}>修改辅料预计到料日期</Button></span>;
 return <form aria-label="修改辅料预计到料日期" onSubmit={event=>{
  event.preventDefault();const form=new FormData(event.currentTarget);
  void onSubmit({action:'修改预计日期',expectedRound:round,expectedVersion:version,expectedMaterialRevision:revision,
   expectedDate:String(form.get('date')??'')||null,note:String(form.get('note')??'')}).then(saved=>{if(saved)close();});
 }}><fieldset disabled={busy}>
  <label>辅料预计到料日期<input autoFocus type="date" name="date" defaultValue={expectedDate??''} required/></label>
  <label>说明<input name="note" maxLength={1000}/></label>
  <Button type="submit">保存预计日期</Button>
  <Button type="button" onClick={close}>取消</Button>
 </fieldset></form>;
}

export function DevelopmentMaterialEventForm({accessory,busy,revision,version,onSubmit}:{accessory:boolean;busy:boolean;revision:number;version:number;onSubmit:(input:DevelopmentMaterialEvent)=>void}){
 const [action,setAction]=useState<DevelopmentMaterialEvent['action']>('到货');
 return <form onSubmit={event=>{
  event.preventDefault();const form=new FormData(event.currentTarget);
  onSubmit({expectedMaterialRevision:revision,expectedVersion:version,action,expectedDate:String(form.get('date')??'')||null,note:String(form.get('note')??''),...(action==='修改预计日期'?{}:{actualTime:developmentTimeFromForm(form)})});
 }}><fieldset disabled={busy}>
  <label>操作<select name="action" value={action} onChange={event=>setAction(event.target.value as DevelopmentMaterialEvent['action'])}>
   <option>到货</option><option>修改预计日期</option>{accessory&&<option>确认代用</option>}
  </select></label>
  <label>预计日期<input type="date" name="date" required={action==='修改预计日期'}/></label>
  {action!=='修改预计日期'&&<DevelopmentOccurrenceInput label="实际发生时间"/>}
  <label>说明<input name="note" maxLength={1000} required={action==='确认代用'}/></label>
  <Button type="submit">确认记录</Button>
 </fieldset></form>;
}
