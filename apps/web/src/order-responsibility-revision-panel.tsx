import { useEffect, useState } from 'react';
import type { OrderResponsibilityRevision } from '@dx-rework/contracts';
import { formatBusinessCurrency } from '@dx-rework/contracts/business-display';
import { Button, Surface } from '@dx-rework/ui';
import { createWebUrls } from '../url-contract.js';
import { createClientRequestId } from './client-request-id.js';
const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
export function OrderResponsibilityRevisionPanel({orderId,orderVersion,onChanged,readOnly=false}:{readOnly?:boolean;orderId:string;orderVersion:number;onChanged:()=>Promise<void>}) {
  const [value,setValue]=useState<OrderResponsibilityRevision|null>(null);
  const [error,setError]=useState(''); const [reason,setReason]=useState(''); const [open,setOpen]=useState(false); const [busy,setBusy]=useState(false);
  const url=apiUrl(`rework-orders/${orderId}/responsibility-revisions`);
  useEffect(()=>{
    const controller=new AbortController();setError('');
    void fetch(url,{credentials:'include',signal:controller.signal}).then(async response=>{
      if(!response.ok) throw new Error('责任历史暂时无法读取，请刷新重试');
      setValue(await response.json() as OrderResponsibilityRevision);
    }).catch((e:unknown)=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'责任历史读取失败');});
    return ()=>controller.abort();
  },[url,orderVersion]);
  const reopen=async()=>{
    if(!value?.currentVersion||!reason.trim()||busy)return;
    setBusy(true);setError('');
    try {
      const response=await fetch(url,{method:'POST',credentials:'include',headers:{'content-type':'application/json','idempotency-key':createClientRequestId()},body:JSON.stringify({expectedOrderVersion:value.orderVersion,expectedDeterminationVersion:value.currentVersion,reason:reason.trim()})});
      const body=await response.json();if(!response.ok)throw new Error(body.error?.message??'重新判责失败');
      setValue(body as OrderResponsibilityRevision);setOpen(false);setReason('');await onChanged();
    }catch(e:unknown){setError(e instanceof Error?e.message:'重新判责失败');}finally{setBusy(false);}
  };
  if(!value?.currentVersion&&!error)return null;
  const current=value?.history[0];
  return <Surface className="rework-responsibility-result">
    <div className="rework-responsibility-result__summary"><strong>责任结果{current?` · V${current.version} · ${current.stage==='draft'?'调整中':'已定稿'}`:''}</strong>
      {current&&<span>本厂 {formatBusinessCurrency(current.ownAmount)} · 外厂 {formatBusinessCurrency(current.externalAmount)} · 实际已扣 {formatBusinessCurrency(value!.paidAmount)}</span>}
      <a href={pageUrl(`ui/tasks/${orderId}?node=responsibility`)}>查看责任明细</a>
      {!readOnly&&value?.canReopen&&<Button onClick={()=>setOpen(!open)}>重新判责</Button>}
    </div>
    {current&&<p>当前版本：{time(current.at)}{value?.revisions[0]&&value.status!=="completed"?` · ${value.revisions[0].actor??'未记录'} 于 ${time(value.revisions[0].at)} 发起调整：${value.revisions[0].reason??''}`:''}</p>}
    {error&&<p role="alert">{error}</p>}
    {open&&<form onSubmit={event=>{event.preventDefault();void reopen();}} className="rework-responsibility-result__form">
      <label>重判原因<textarea required maxLength={500} value={reason} onChange={event=>setReason(event.target.value)} /></label>
      <p>回到责任判定，由原处理人调整后提交老板确认。原工资与已扣款记录保留，新责任继续处理剩余金额。</p>
      <Button type="submit" disabled={busy||!reason.trim()}>{busy?'正在创建新责任版本…':'确认重新判责'}</Button>
      <Button type="button" disabled={busy} onClick={()=>setOpen(false)}>取消</Button>
    </form>}
    {!!value?.history.length&&<details><summary>责任版本与确认历史 · {value.history.length} 个版本</summary>
      {value.revisions.map(row=><p key={row.id}>{time(row.at)} · {row.actor??'未记录'} 发起重判：{row.reason}</p>)}
      {value.history.map(row=><div className="rework-responsibility-result__version" key={row.id}><b>V{row.version} · {row.stage==='draft'?'草稿':'定稿'}</b><span>{time(row.at)} · {row.actor??'未记录'} · 本厂 {formatBusinessCurrency(row.ownAmount)} / 外厂 {formatBusinessCurrency(row.externalAmount)}</span>{row.reason&&<span>原因：{row.reason}</span>}{row.signature&&<span>老板{row.signature.decision==='approved'?'确认':'驳回'}：{row.signature.actor??'未记录'} · {time(row.signature.at)}</span>}</div>)}
    </details>}
  </Surface>;
}
