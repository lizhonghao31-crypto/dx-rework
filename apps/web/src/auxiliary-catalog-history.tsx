import {useEffect,useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Dialog,DialogHeader} from '@astryxdesign/core/Dialog';
import {Table} from '@astryxdesign/core/Table';
import {AuxiliaryHistorySchema,type AuxiliaryItem} from '@dx-rework/contracts/auxiliary-catalog';
import {ListPagination} from './list-pagination.js';
import {catalogRequest} from './auxiliary-catalog-api.js';
import {designerAstryxCss} from './designer-astryx.js';

const actions:Record<string,string>={
 'auxiliary_catalog.create':'新增',
 'auxiliary_catalog.rename':'改名',
 'auxiliary_catalog.disable':'停用',
 'auxiliary_catalog.merge':'合并',
};
export function AuxiliaryCatalogHistory({item,onClose}:{item:AuxiliaryItem;onClose():void}){
 const [page,setPage]=useState(1),[refresh,setRefresh]=useState(0);
 const [result,setResult]=useState<ReturnType<typeof AuxiliaryHistorySchema.parse>|null>(null);
 const [error,setError]=useState(''),[reading,setReading]=useState(true);
 useEffect(()=>{
  const abort=new AbortController();setReading(true);setResult(null);setError('');
  void catalogRequest(`/${item.id}/versions?page=${page}`,'GET',undefined,undefined,abort.signal)
   .then(data=>{if(!abort.signal.aborted)setResult(AuxiliaryHistorySchema.parse(data));})
   .catch(error=>{if(!abort.signal.aborted)setError(error instanceof Error?error.message:'未能读取原版本，请重试');})
   .finally(()=>{if(!abort.signal.aborted)setReading(false);});
  return()=>abort.abort();
 },[item.id,page,refresh]);
 return <Dialog isOpen onOpenChange={open=>{if(!open)onClose();}} className="dx-designer-astryx auxiliary-catalog-history">
  <style data-designer-style="astryx-v0.7.16">{designerAstryxCss}</style>
  <DialogHeader title={`${item.name} · 版本历史`} onOpenChange={open=>{if(!open)onClose();}}/>
  {reading&&<p role="status">正在读取原版本…</p>}
  {error&&<p role="alert">{error}<Button label="重新读取历史" onClick={()=>setRefresh(value=>value+1)}/></p>}
  {result&&<div className="auxiliary-catalog-table"><div className="auxiliary-catalog-table-canvas"><Table data={result.items} idKey="version" density="balanced" aria-label="共享辅料版本历史" columns={[
   {key:'version',header:'版本'},
   {key:'name',header:'原名称'},
   {key:'auxiliaryKind',header:'种类'},
   {key:'specification',header:'原规格',renderCell:row=>row.specification||'未填写'},
   {key:'supplier',header:'原供应方',renderCell:row=>row.supplier||'未填写'},
   {key:'action',header:'变更',renderCell:row=>actions[row.action]??'历史变更'},
   {key:'reason',header:'原因',renderCell:row=>row.reason||'未记录'},
   {key:'changedBy',header:'操作人',renderCell:row=>row.changedBy||'未记录'},
   {key:'changedAt',header:'时间',renderCell:row=>new Date(row.changedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})},
  ]}/></div></div>}
  <ListPagination page={page} totalPages={result?Math.max(1,Math.ceil(result.total/result.pageSize)):null} total={result?.total??null} busy={reading} onPageChange={setPage} ariaLabel="辅料历史分页"/>
  <Button label="关闭版本历史" onClick={onClose}/>
 </Dialog>;
}
