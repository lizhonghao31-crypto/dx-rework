import {useState} from 'react';
import type {DevelopmentOccurrence} from '@dx-rework/contracts/digital-development-execution';

export function developmentTimeFromForm(form:FormData):DevelopmentOccurrence|undefined{
 const precision=form.get('actualTimeMode');
 if(precision==='unknown')return {precision:'unknown'};
 if(precision==='date')return {precision:'date',date:String(form.get('actualDate')??'')};
 if(precision==='instant'){
  const value=String(form.get('actualAt')??''),date=new Date(`${value}+08:00`);
  return {precision:'instant',at:Number.isFinite(date.getTime())?date.toISOString():value};
 }
 return undefined;
}

/** The server supplies the order's business clock for an action happening now. */
export function DevelopmentOccurrenceInput({label='实际完成时间'}:{label?:string}){
 const [mode,setMode]=useState('current');
 return <>
  <label>{label}<select name="actualTimeMode" value={mode} onChange={event=>setMode(event.target.value)}>
   <option value="current">现在办理</option>
   <option value="instant">补登具体时间</option>
   <option value="date">只知道日期</option>
   <option value="unknown">时间不详</option>
  </select></label>
  {mode==='instant'&&<label>发生时间（北京时间）<input name="actualAt" type="datetime-local" step="0.001" required/></label>}
  {mode==='date'&&<label>发生日期<input name="actualDate" type="date" required/></label>}
 </>;
}
