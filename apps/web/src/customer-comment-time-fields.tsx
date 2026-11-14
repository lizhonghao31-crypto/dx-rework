import {useState} from 'react';
import type {z} from 'zod';
import type {CustomerCommentOccurrenceSchema} from '@dx-rework/contracts/digital-development-technical';
export function customerCommentTimeFromForm(form:FormData):z.infer<typeof CustomerCommentOccurrenceSchema>{
 const precision=form.get('commentTimePrecision');
 if(precision==='current')return {precision:'current'};
 if(precision==='date')return {precision:'date',date:String(form.get('commentActualDate')??'')};
 if(precision==='instant'){const value=String(form.get('commentActualAt')??''),at=new Date(`${value}+08:00`);return {precision:'instant',at:Number.isFinite(at.getTime())?at.toISOString():value};}
 return {precision:'unknown'};
}
/** Registration is not an assertion that the customer just replied. */
export function CustomerCommentTimeFields({supplement=false}:{supplement?:boolean}){
 const [precision,setPrecision]=useState(supplement?'date':'unknown');
 return <><label>客户实际反馈时间<select aria-label="客户实际反馈时间" name="commentTimePrecision" value={precision} onChange={e=>setPrecision(e.target.value)}>
  {!supplement&&<option value="unknown">时间不详</option>}
  <option value="date">只知道日期</option><option value="instant">知道具体时间</option>{!supplement&&<option value="current">刚刚收到客户反馈</option>}
 </select></label>{precision==='date'&&<label>客户实际反馈日期<input aria-label="客户实际反馈日期" name="commentActualDate" type="date" required/></label>}
 {precision==='instant'&&<label>客户实际反馈时刻（北京时间）<input aria-label="客户实际反馈时刻（北京时间）" name="commentActualAt" type="datetime-local" step="0.001" required/></label>}</>;
}
