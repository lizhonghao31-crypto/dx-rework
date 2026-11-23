import {useEffect,useRef,useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Pagination} from '@astryxdesign/core/Pagination';
import {TextInput} from '@astryxdesign/core/TextInput';

export function AstryxPageControls({page,total,pageSize,label,busy=false,onPageChange}:{
 page:number;total:number|null;pageSize:number;label:string;busy?:boolean;onPageChange(page:number):void;
}){
 const [input,setInput]=useState(String(page)),[error,setError]=useState('');
 const composing=useRef(false);
 const last=total===null?null:Math.max(1,Math.ceil(total/pageSize));
 useEffect(()=>{setInput(String(page));setError('');},[page,last]);
 if(last===null||last===1&&page===1)return null;
 if(page>last)return <div role="group" aria-label={label}>
  <p>共 {total} 条。当前页超出最新范围。</p>
  <Button label={`返回第 ${last} 页`} isDisabled={busy} onClick={()=>onPageChange(last)}/>
 </div>;
 const go=(target:number)=>{
  if(!busy&&Number.isSafeInteger(target)&&target>=1&&target<=last&&target!==page)onPageChange(target);
 };
 return <div className="my-todos-pagination">
  <span>共 {total} 条</span>
  <Pagination label={label} page={page} totalPages={last} onChange={go} isDisabled={busy} size="sm"/>
  <form className="dx-page-jump" onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}
   onSubmit={event=>{
    event.preventDefault();
    if(busy||composing.current)return;
    const raw=input.trim(),target=Number(raw);
    if(!/^\d+$/.test(raw)||!Number.isSafeInteger(target)||target<1||target>last){setError(`请输入 1 至 ${last} 的整数页码`);return;}
    setError('');go(target);
   }}>
   <TextInput label="跳转页码" isLabelHidden inputMode="numeric" value={input} size="sm" isDisabled={busy}
    onChange={value=>{setInput(value);setError('');}}
    onKeyDown={event=>{if(event.key==='Enter'&&(event.nativeEvent.isComposing||event.nativeEvent.keyCode===229))event.preventDefault();}}
    {...(error?{status:{type:'error',message:error}}:{})}/>
   <Button label="跳转" type="submit" size="sm" isDisabled={busy}/>
  </form>
 </div>;
}
