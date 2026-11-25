import {useEffect,useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Dialog,DialogHeader} from '@astryxdesign/core/Dialog';
import {Table} from '@astryxdesign/core/Table';
import {AuxiliaryHistorySchema,type AuxiliaryItem} from '@dx-rework/contracts/auxiliary-catalog';
import {ListPagination} from './list-pagination.js';
import {catalogRequest} from './auxiliary-catalog-api.js';
import {designerAstryxCss} from './designer-astryx.js';
import type {CockpitDocumentSnapshot} from './cockpit-documents-model.js';

const actions:Record<string,string>={
 'auxiliary_catalog.create':'新增',
 'auxiliary_catalog.rename':'改名',
 'auxiliary_catalog.disable':'停用',
 'auxiliary_catalog.merge':'合并',
 'auxiliary_catalog.reference-pricing':'调整参考价',
};
export function AuxiliaryCatalogHistory({item,exactVersion,session,onClose}:{item:Pick<AuxiliaryItem,'id'|'name'>;exactVersion?:number;session?:CockpitDocumentSnapshot;onClose():void}){
 const [page,setPage]=useState(1),[refresh,setRefresh]=useState(0);
 const [result,setResult]=useState<ReturnType<typeof AuxiliaryHistorySchema.parse>|null>(null);
 const [error,setError]=useState(''),[reading,setReading]=useState(true);
 useEffect(()=>{
  const abort=new AbortController();setReading(true);setResult(null);setError('');
  const query=new URLSearchParams({page:String(page),...(exactVersion!==undefined?{version:String(exactVersion)}:{})});
  const path=`/${item.id}/versions?${query}`;
  const parse=(data:unknown)=>{
   const history=AuxiliaryHistorySchema.parse(data);
   if(exactVersion!==undefined&&(history.items.length!==1||history.items[0]!.version!==exactVersion||history.items[0]!.id!==item.id))
    throw Error('所选辅料历史版本不可用，未显示其他版本。');
   return history;
  };
  const request=session?session.readChecked(`master-data/auxiliaries${path}`,abort.signal,parse)
   :catalogRequest(path,'GET',undefined,undefined,abort.signal).then(parse);
  void request.then(history=>{if(!abort.signal.aborted)setResult(history);})
   .catch(error=>{if(!abort.signal.aborted)setError(error instanceof Error?error.message:'未能读取原版本，请重试');})
   .finally(()=>{if(!abort.signal.aborted)setReading(false);});
  return()=>abort.abort();
 },[item.id,exactVersion,session,page,refresh]);
 return <Dialog isOpen onOpenChange={open=>{if(!open)onClose();}} className="dx-designer-astryx auxiliary-catalog-history">
  <style data-designer-style="astryx-v0.7.16">{designerAstryxCss}</style>
  <DialogHeader title={`${item.name} · ${exactVersion===undefined?'版本历史':`采用版本 ${exactVersion}`}`} onOpenChange={open=>{if(!open)onClose();}}/>
  {reading&&<p role="status">正在读取原版本…</p>}
  {error&&<p role="alert">{error}<Button label="重新读取历史" onClick={()=>setRefresh(value=>value+1)}/></p>}
  {result&&<div className="auxiliary-catalog-table"><div className="auxiliary-catalog-table-canvas"><Table data={result.items} idKey="version" density="balanced" aria-label="共享辅料版本历史" columns={[
   {key:'version',header:'版本'},
   {key:'name',header:'原名称'},
   {key:'auxiliaryKind',header:'种类'},
   {key:'specification',header:'原规格',renderCell:row=>row.specification||'未填写'},
   ...(result.items.some(row=>row.referencePricing!==undefined)?[{key:'referencePricing' as const,header:'原参考价 / 单位',
    renderCell:(row:(typeof result.items)[number])=>row.referencePricing?`${row.referencePricing.amount} 元 / ${row.referencePricing.unit}`:'未记录'}]:[]),
   {key:'action',header:'变更',renderCell:row=>actions[row.action]??'历史变更'},
   {key:'reason',header:'原因',renderCell:row=>row.reason||'未记录'},
   {key:'changedBy',header:'操作人',renderCell:row=>row.changedBy||'未记录'},
   {key:'changedAt',header:'时间',renderCell:row=>new Date(row.changedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})},
  ]}/></div></div>}
  {exactVersion===undefined&&<ListPagination page={page} totalPages={result?Math.max(1,Math.ceil(result.total/result.pageSize)):null} total={result?.total??null} busy={reading} onPageChange={setPage} ariaLabel="辅料历史分页"/>}
  <Button label="关闭版本历史" onClick={onClose}/>
 </Dialog>;
}
