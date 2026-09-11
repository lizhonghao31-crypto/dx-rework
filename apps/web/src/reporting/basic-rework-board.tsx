import type { BasicReworkPage } from "@dx-rework/contracts/reporting";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useState, type ReactNode } from "react";
import { verifySession } from "../auth.js";
import { Header, Shell } from "../components.js";
import { ListPagination } from "../list-pagination.js";
import { useDebouncedValue } from "../use-debounced-value.js";
import { createWebUrls } from "../../url-contract.js";
import { loadBasicReworkOrders } from "./reporting-client.js";
import "./basic-rework-board.css";
const {apiUrl}=createWebUrls(import.meta.env.BASE_URL);

export function ReworkBoardAccess({basic,business}:{basic:ReactNode;business:ReactNode}) {
  const [access,setAccess]=useState<{basic:boolean;business:boolean}|null>(null);
  const [showBasic,setShowBasic]=useState(false);
  useEffect(()=>{let mounted=true;void verifySession().then(session=>{
    if(!mounted)return;
    if(session==="denied"||session.status!=="authorized"){setAccess({basic:false,business:false});return;}
    const user=session.user;
    const original=user.isRoot===true||user.businessRoles?.includes("owner_group")===true
      ||["dashboard:management:read","dashboard:site:read","report:view","rework:related_orders:view"].some(cap=>user.capabilities.includes(cap));
    setAccess({basic:user.capabilities.includes("rework:basic:view"),business:original});setShowBasic(!original);
  });return()=>{mounted=false;};},[]);
  if(!access)return <Surface>正在读取权限…</Surface>;
  if(!access.basic)return access.business?business:<Surface>暂无查看权限</Surface>;
  return <>{access.business&&<div className="basic-rework-switch"><button type="button" aria-pressed={showBasic} onClick={()=>setShowBasic(!showBasic)}>{showBasic?"返回业务返工看板":"查看全部返工基础信息"}</button></div>}{showBasic?basic:business}</>;
}
export function BasicReworkBoard(){
  const [q,setQ]=useState("");const search=useDebouncedValue(q,200);
  const [status,setStatus]=useState("");const [page,setPage]=useState(1);const [refresh,setRefresh]=useState(0);
  const [data,setData]=useState<BasicReworkPage|null>(null);const [error,setError]=useState("");const [busy,setBusy]=useState(true);
  useEffect(()=>{const controller=new AbortController();setBusy(true);setError("");
    void loadBasicReworkOrders({q:search||undefined,status:status||undefined,page:String(page)},controller.signal)
      .then(value=>{if(!controller.signal.aborted)setData(value);}).catch((e:unknown)=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:"读取失败");})
      .finally(()=>{if(!controller.signal.aborted)setBusy(false);});return()=>controller.abort();
  },[search,status,page,refresh]);
  return <Shell active="返工单看板"><div className="rework-query-content">
    <Header title="返工单看板" subtitle="查看返工基础资料、照片与当前进度。" badge={busy?"查询中":`${data?.totalCount??0} 条返工单`} />
    <Surface className="reporting-filters">
      <InsetField label="关键词" value={q} onChange={event=>{setQ(event.target.value);setPage(1);}} placeholder="返工号 / 款号 / 加工厂 / 跟单姓名" />
      <label>状态<select value={status} onChange={event=>{setStatus(event.target.value);setPage(1);}}>
        <option value="">全部状态</option><option value="draft">草稿</option><option value="pending_process_configuration">待配置工序</option>
        <option value="pending_ie_review">待 IE 审核</option><option value="pending_task_assignment">待分工</option><option value="in_progress">返工执行中</option>
        <option value="pending_order_review">待最终数量确认</option><option value="pending_final_quantity_ie_review">最终数量待 IE 复核</option>
        <option value="pending_quantity_adjustment_ie_review">数量调整待 IE</option><option value="pending_responsibility_determination">责任判定与资料核验</option>
        <option value="pending_owner_signature">待老板签字</option><option value="pending_responsibility_action">责任结算中</option>
        <option value="completed">已完成</option><option value="cancelled">已取消</option>
      </select></label><Button onClick={()=>setRefresh(n=>n+1)}>刷新</Button>
    </Surface>
    {error&&<Surface><p role="alert">{error}</p></Surface>}
    {!busy&&!error&&data?.items.length===0&&<Surface>没有符合条件的返工单。</Surface>}
    <div className="reporting-order-grid">{data?.items.map(order=><Surface className="reporting-order-card basic-rework-card" key={order.reworkOrderId}>
      <div className="reporting-order-card__main"><div className="reporting-order-card__heading"><div><strong>{order.styleNo??"款号未填写"}</strong><small>{order.reworkNo??"返工单"}</small></div>
        <StatusBadge tone={order.status==="completed"?"success":"info"}>{order.nodeLabel}</StatusBadge></div>
      <dl><div><dt>加工厂</dt><dd>{order.processingFactory??"未填写"}</dd></div><div><dt>跟单</dt><dd>{order.merchandiser??"未填写"}</dd></div>
        <div><dt>返工数量</dt><dd>{order.quantity??"未填写"}</dd></div><div><dt>订单号</dt><dd>{order.orderNo??"未填写"}</dd></div></dl>
      <details><summary>查看基础资料与照片</summary><p>返工原因：{order.reason??"未填写"}</p><p>问题部位：{order.problemPart??"未填写"}</p><p>问题描述：{order.problemDescription??"未填写"}</p>
        <div className="basic-rework-photos">{order.photos.map(photo=><a key={photo.attachmentId} href={apiUrl(`tools/attachments/${photo.attachmentId}/download?mode=preview`)} target="_blank" rel="noreferrer"><img src={apiUrl(`tools/attachments/${photo.attachmentId}/download?mode=preview`)} alt={photo.filename} loading="lazy" /></a>)}</div>
        {order.photos.length===0&&<p>暂无照片</p>}
      </details></div>
    </Surface>)}</div>
    {data&&<ListPagination page={data.page} totalPages={data.totalPages} busy={busy} ariaLabel="返工基础信息分页" onPageChange={setPage} />}
  </div></Shell>;
}
