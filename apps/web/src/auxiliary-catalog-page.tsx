import {useState} from 'react';
import {Button,Surface} from '@dx-rework/ui';
import {Shell} from './components.js';
import {AuxiliaryCatalogDialog} from './auxiliary-catalog-dialog.js';
export function AuxiliaryCatalogPage(){
 const [open,setOpen]=useState(true);
 return <Shell active="共享辅料目录"><Surface><h1>共享辅料目录</h1><p>直接维护共享辅料。新增、改名、合并重复项及停用不需要订单或设计师草稿；历史订单保留原资料快照。</p><Button type="button" onClick={()=>setOpen(true)}>打开共享辅料目录</Button>{open&&<AuxiliaryCatalogDialog onClose={()=>setOpen(false)}/>}</Surface></Shell>;
}
