import {useEffect,useState} from 'react';
import type {OrderTimeRule} from '@dx-rework/contracts/order-time-plan';
import {OrderTimeRuleSchema} from '@dx-rework/contracts/order-time-plan';
import {timeCalendars,nodeTimeText,nodeCalendarText} from './order-time-settings-model.js';

/** One local edit. Cancelling never mutates the parent standard or its preview. */
export function OrderTimeNodeFields({nodeKey,label,value,current,readOnly=false,onCancel,onConfirm,onEditingChange}:{nodeKey:string;label:string;value:OrderTimeRule;current:OrderTimeRule;readOnly?:boolean;onCancel():void;onConfirm(value:OrderTimeRule):void;onEditingChange(value:{dirty:boolean;preview:OrderTimeRule|null}):void}){
 const [draft,setDraft]=useState(()=>structuredClone(value)),[unit,setUnit]=useState(value.kind==='offset'?'days':value.minutes!==null&&value.minutes>=1440&&value.minutes%1440===0?'days':'hours');
 const [raw,setRaw]=useState(value.kind==='offset'?value.days===null?'':String(value.days):value.minutes===null?'':String(value.minutes/(unit==='days'?1440:60))),[error,setError]=useState('');
 const editable=!['event','date'].includes(draft.kind),included=draft.kind==='included';
 const investment=nodeKey==='material_investment'&&draft.kind==='event',editableReminder=editable||investment;
 const [accessoryHours,setAccessoryHours]=useState(()=>value.kind==='event'&&value.accessoriesLeadTime?String(value.accessoriesLeadTime.minutes/60):'');
 const [accessoryCalendar,setAccessoryCalendar]=useState(()=>value.kind==='event'?value.accessoriesLeadTime?.calendar??'continuous':'continuous');
 const candidate={...draft,...(investment?{accessoriesLeadTime:accessoryHours.trim()===''?undefined:{minutes:Number(accessoryHours)*60,calendar:accessoryCalendar}}:{})};

 useEffect(()=>{
  const number=raw.trim()===''?null:Number(raw),minutes=number===null?null:number*(unit==='days'?1440:60);
  const parsed=OrderTimeRuleSchema.safeParse(draft.kind==='offset'?{...draft,days:number}:{...candidate,...(editable?{minutes}:{})});
  onEditingChange({dirty:!parsed.success||JSON.stringify(parsed.data)!==JSON.stringify(value),preview:parsed.success?parsed.data:null});
 },[draft,raw,unit,value,editable,investment,accessoryHours,accessoryCalendar,onEditingChange]);
 useEffect(()=>()=>onEditingChange({dirty:false,preview:null}),[onEditingChange]);
 const accept=()=>{
  const number=raw.trim()===''?null:Number(raw),minutes=number===null?null:number*(unit==='days'?1440:60);
  const result=OrderTimeRuleSchema.safeParse(draft.kind==='offset'?{...draft,days:number}:{...candidate,...(editable?{minutes}:{})});
  if(!result.success){setError('请填写有效用时；还没确定可留空。');return;}
  onConfirm(result.data);
 };
 return <section className="r5-node-editor" aria-label={label+'设置'}>
  <h2>{label}</h2>{nodeKey==='ship_sample_advance'&&<p className="r5-node-anchor">按客户交期提前，且不晚于大货生产开始。</p>}<div className="r5-editor-fields">
   <span>当前用时</span><output>{nodeTimeText(current,nodeKey)}</output>
   {editable&&<><label htmlFor={'r5-node-value-'+nodeKey}>改为</label><div className="r5-duration-input"><input id={'r5-node-value-'+nodeKey} aria-label={label+'用时'} inputMode="decimal" value={raw} disabled={readOnly} onChange={e=>{setRaw(e.target.value);setError('');}}/>{draft.kind==='offset'?<span>天</span>:<select aria-label={label+'时间单位'} value={unit} disabled={readOnly} onChange={e=>{const next=e.target.value,n=Number(raw);if(raw.trim()&&Number.isFinite(n))setRaw(String(n*(unit==='days'?1440:60)/(next==='days'?1440:60)));setUnit(next);}}><option value="hours">小时</option><option value="days">天</option></select>}</div></>}
   {investment&&<><label htmlFor="r5-accessory-procurement-hours">辅料采购周期</label><div className="r5-duration-input"><input id="r5-accessory-procurement-hours" inputMode="decimal" value={accessoryHours} disabled={readOnly} onChange={event=>{setAccessoryHours(event.target.value);setError('');}}/><span>小时</span></div>
    <label htmlFor="r5-accessory-procurement-calendar">辅料采购日历</label><select id="r5-accessory-procurement-calendar" value={accessoryCalendar} disabled={readOnly} onChange={event=>setAccessoryCalendar(event.target.value as typeof accessoryCalendar)}>{Object.entries(timeCalendars).map(([key,text])=><option key={key} value={key}>{text}</option>)}</select></>}
   <label htmlFor={'r5-node-calendar-'+nodeKey}>哪些天计时</label>{editableReminder&&!included&&draft.kind!=='offset'?<select id={'r5-node-calendar-'+nodeKey} value={draft.calendar??''} disabled={readOnly} onChange={e=>setDraft({...draft,calendar:e.target.value as OrderTimeRule['calendar']})}><option value="">还没设置</option>{Object.entries(timeCalendars).map(([key,text])=><option key={key} value={key}>{text}</option>)}</select>:<output>{nodeCalendarText(draft,nodeKey)}</output>}
   {editableReminder&&<><label htmlFor={'r5-node-reminder-'+nodeKey}>提醒</label><div><input id={'r5-node-reminder-'+nodeKey} className="r5-switch" type="checkbox" role="switch" checked={draft.reminder.enabled} disabled={readOnly} onChange={e=>setDraft({...draft,reminder:{...draft.reminder,enabled:e.target.checked}})}/></div></>}
   {editableReminder&&draft.reminder.enabled&&draft.kind!=='offset'&&<><label htmlFor={'r5-node-warning-'+nodeKey}>用掉多少时间时提醒</label><div className="r5-duration-input"><input id={'r5-node-warning-'+nodeKey} type="number" min={1} max={99} value={draft.reminder.percent} disabled={readOnly} onChange={e=>setDraft({...draft,reminder:{...draft.reminder,percent:Number(e.target.value)}})}/><span>%</span></div></>}
  </div>{error&&<p role="alert">{error}</p>}
  <footer><button type="button" className="r5-button" onClick={onCancel}>取消</button>{!readOnly&&<button type="button" className="r5-button r5-primary" onClick={accept}>确定</button>}</footer>
 </section>;
}
