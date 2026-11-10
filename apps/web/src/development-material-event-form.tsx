import {useState} from 'react';
import {Button} from '@dx-rework/ui';
import type {DevelopmentMaterialEvent} from '@dx-rework/contracts/digital-development';
import {DevelopmentOccurrenceInput,developmentTimeFromForm} from './development-occurrence-input.js';

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
