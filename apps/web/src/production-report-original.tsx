import {useCallback} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {ProductionReportingDetailSchema} from '@dx-rework/contracts';
import {DigitalIdSchema} from '@dx-rework/contracts/digital-production';
import {formatBusinessDecimal} from '@dx-rework/contracts/business-display';
import {createWebUrls} from '../url-contract.js';
import {shanghaiBusinessTime} from './business-date.js';
import {DesignerOriginalShell} from './designer-original-shell.js';
import {digitalDetailReturnUrl} from './digital-detail-route.js';
import {useForegroundRead} from './use-foreground-read.js';
import {useForegroundWait} from './foreground-loading.js';

const urls=createWebUrls(import.meta.env.BASE_URL);

export function ProductionReportOriginal({productionOrderId}:{productionOrderId:string}){
 const query=new URLSearchParams(location.search),rawDecision=query.get('factoryDecisionId');
 const decision=rawDecision===null?null:DigitalIdSchema.safeParse(rawDecision);
 const record=DigitalIdSchema.safeParse(query.get('originalReport'));
 const valid=record.success&&query.getAll('originalReport').length===1&&query.getAll('factoryDecisionId').length<=1&&(decision===null||decision.success);
 const back=digitalDetailReturnUrl(query.get('returnTo'),urls.base)??urls.pageUrl('ui/production-reporting');
 const load=useCallback(async(signal:AbortSignal)=>{
  const suffix=rawDecision?`?${new URLSearchParams({factoryDecisionId:rawDecision})}`:'';
  const response=await fetch(urls.apiUrl(`production-reporting/${productionOrderId}${suffix}`),{credentials:'include',cache:'no-store',signal});
  if(!response.ok)throw Error([401,403,404].includes(response.status)?'原生产填报不存在或不在当前授权范围。':'生产填报读取失败，请重试。');
  const detail=ProductionReportingDetailSchema.parse(await response.json());
  if(detail.order.productionOrderId!==productionOrderId||(detail.order.factoryDecisionId??null)!==rawDecision)
   throw Error('生产单或工厂版本与原记录不一致。');
  return detail;
 },[productionOrderId,rawDecision]);
 const reader=useForegroundRead(productionOrderId,valid?`${record.data}:${rawDecision??'original'}`:null,load);
 useForegroundWait(reader.foregroundKey);
 const history=reader.value?.history.find(item=>item.reportId===record.data);
 const line=history&&reader.value?.order.lines.find(item=>item.position===history.position);
 return <DesignerOriginalShell title={history?`生产填报 · 第 ${history.revision} 版 · 只读`:'原生产填报'} onClose={()=>window.location.assign(back)}>
  {!valid||reader.value&&!history?<p role="alert">找不到所选厂单的原生产填报，请返回核对。</p>:
   reader.error?<p role="alert">{reader.error.message}<Button label="重新读取生产填报" size="sm" onClick={reader.retry}/></p>:
   history?<dl>
    <div><dt>原厂单</dt><dd>{reader.value?.order.supplierName}</dd></div>
    <div><dt>本次填报范围</dt><dd>{[`原行序 ${history.position}`,line?.styleNo,line?.color].filter(Boolean).join(' · ')}</dd></div>
    <div><dt>业务日期</dt><dd>{history.businessDate}</dd></div>
    <div><dt>本次数量</dt><dd>{formatBusinessDecimal(history.quantity)} 件</dd></div>
    <div><dt>登记人员及时间</dt><dd>{history.actorName} · {shanghaiBusinessTime(history.createdAt)}</dd></div>
    <div><dt>记录状态</dt><dd>{history.effective?'当前有效':'已被订正'}</dd></div>
    {history.reason&&<div><dt>原登记原因</dt><dd>{history.reason}</dd></div>}
   </dl>:<p role="status">正在读取所选生产填报…</p>}
 </DesignerOriginalShell>;
}
