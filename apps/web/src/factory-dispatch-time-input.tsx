import {useState} from 'react';

/** Missing occurrence means the original server command records its trusted current time. */
export function factoryDispatchTime(form:FormData):{occurredAt?:string}{
 const mode=form.get('dispatchTimeMode');
 if(mode==='current')return {};
 if(mode!=='manual')throw new Error('请选择有效的发厂时间方式');
 const value=String(form.get('at')??'');
 if(!value)throw new Error('请填写实际发厂时间');
 const date=new Date(`${value}+08:00`);
 if(!Number.isFinite(date.getTime()))throw new Error('请填写有效的北京时间');
 return {occurredAt:date.toISOString()};
}

export function FactoryDispatchTimeInput(){
 const [manual,setManual]=useState(false),[value,setValue]=useState('');
 return <>
  <label>发厂时间<select name="dispatchTimeMode" value={manual?'manual':'current'} onChange={event=>setManual(event.target.value==='manual')}><option value="current">按本单当前时间登记</option><option value="manual">手工填写实际时间</option></select></label>
  {manual&&<label>实际发厂时间（北京时间）<input name="at" type="datetime-local" step="0.001" required value={value} onChange={event=>setValue(event.target.value)}/></label>}
 </>;
}
