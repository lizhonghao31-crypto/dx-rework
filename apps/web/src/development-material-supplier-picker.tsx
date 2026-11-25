import {Button} from '@astryxdesign/core/Button';
import {Dialog,DialogHeader} from '@astryxdesign/core/Dialog';
import {TextInput} from '@astryxdesign/core/TextInput';
import {DevelopmentMaterialSupplierOptionSchema,type DevelopmentMaterialSupplierOption} from '@dx-rework/contracts/digital-development';
import {useCallback,useState} from 'react';
import {z} from 'zod';
import {digitalRequest} from './digital-production-api.js';
import {useDebouncedValue} from './use-debounced-value.js';
import {useForegroundRead} from './use-foreground-read.js';
import {useForegroundWait} from './foreground-loading.js';

const OptionsSchema=z.object({items:z.array(DevelopmentMaterialSupplierOptionSchema)}).strict();
export function DevelopmentMaterialSupplierPicker({disabled,onChoose,onClose}:{
 disabled:boolean;onChoose:(value:DevelopmentMaterialSupplierOption)=>void;onClose:()=>void;
}){
 const [search,setSearch]=useState(''),query=useDebouncedValue(search.trim(),250);
 const load=useCallback(async(signal:AbortSignal)=>OptionsSchema.parse(await digitalRequest(
  'development/material-suppliers?'+new URLSearchParams({q:query}),'GET',undefined,undefined,{signal}
 )),[query]);
 const read=useForegroundRead('development-material-suppliers',query,load);
 useForegroundWait(read.foregroundKey);
 const current=search.trim()===query&&!read.waiting;
 const close=(open:boolean)=>{if(!open)onClose();};
 return <Dialog isOpen onOpenChange={close} purpose="form" width="min(92vw, 520px)" className="dx-designer-astryx development-material-supplier-picker">
  <DialogHeader title="选择面辅料供应商" onOpenChange={close}/>
  <TextInput label="搜索面辅料供应商" value={search} onChange={value=>setSearch(value.slice(0,100))} isDisabled={disabled}/>
  {read.error&&<p role="alert">{read.error.message} <Button type="button" label="重试读取" size="sm" onClick={read.retry}/></p>}
  {current&&read.value&&(!read.value.items.length?<p>没有符合条件的有效供应商</p>:<ul aria-label="有效面辅料供应商">{read.value.items.map(item=>(
   <li key={item.supplierId}><Button type="button" label={`${item.name} · ${item.code}`} size="sm" variant="ghost" isDisabled={disabled} onClick={()=>onChoose(item)}/></li>
  ))}</ul>)}
 </Dialog>;
}
