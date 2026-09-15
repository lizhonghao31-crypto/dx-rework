import { FinanceNodeReadSchema, type FinanceNodeKey, type FinanceNodeRead } from "@dx-rework/contracts/reporting";
import { Surface } from "@dx-rework/ui";
import { useEffect, useState } from "react";
import { createWebUrls } from "../../url-contract.js";
import "./finance-node-panel.css";
const {apiUrl}=createWebUrls(import.meta.env.BASE_URL);
const labels:Record<string,string>={draft:"草稿",pending_ie_review:"待 IE 审核",approved:"已批准",rejected:"已驳回",superseded:"已替换",active:"当前有效",individual:"个人",collective:"集体",piece:"件",hour:"小时",effective:"已生效",pending_merchandiser_confirmation:"待跟单确认",expired:"已失效",finalized:"已定稿",own_factory:"本厂",processing_factory:"加工厂",embroidery_factory:"印绣花厂",washing_factory:"洗水厂",fabric_supplier:"面料商",pending:"待处理",pending_business_signoff:"待业务签字",pending_payables_confirmation:"待应付确认",deduction_follow_up:"扣款跟进中",pending_special_approval:"待财务特批",returned:"已退回",pending_responsibility_revision:"待责任修订",closed:"已结案",full:"全额扣款",partial:"部分扣款",not_deducted:"未扣款",over_deducted:"超额扣款（已特批）",deduction:"扣款",adjustment:"调整",reversal:"冲销",internal:"正式工",temporary:"临时工"};
const display=(value:string|null)=>{
 if(value===null)return "—";
 if(/^\d{4}-\d{2}-\d{2}T/.test(value))return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short',hour12:false}).format(new Date(value));
 return labels[value]??value;
};
export function FinanceNodePanel({orderId,node,attachments=[],onlyWages=false}:{orderId:string;node:FinanceNodeKey;attachments?:readonly {attachmentId:string;filename:string}[];onlyWages?:boolean}){
 const [data,setData]=useState<FinanceNodeRead|null>(null);const [error,setError]=useState("");
 useEffect(()=>{const controller=new AbortController();setData(null);setError("");
  void fetch(apiUrl(`management/rework-orders/${orderId}/finance-nodes/${node}`),{credentials:'include',signal:controller.signal,headers:{accept:'application/json'}})
   .then(async response=>{if(!response.ok){const value=await response.json().catch(()=>null) as {error?:{message?:string}}|null;throw new Error(value?.error?.message??'节点读取失败');}return FinanceNodeReadSchema.parse(await response.json());})
   .then(value=>{if(!controller.signal.aborted)setData(value);}).catch((e:unknown)=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'节点读取失败');});
  return()=>controller.abort();
 },[orderId,node]);
 if(error)return <Surface><p role="alert">{error}</p></Surface>;
 if(!data)return <Surface>正在读取节点记录…</Surface>;
 return <div className="finance-node-read" aria-label="财务节点只读记录">
  {data.sections.filter(section=>!onlyWages||section.title==='工资明细').map(section=><Surface key={section.title}>
   <h3>{section.title}</h3>
   {section.rows.length?<div className="finance-node-table"><table><thead><tr>{section.columns.map(column=><th key={column}>{column}</th>)}</tr></thead>
    <tbody>{section.rows.map((row,index)=><tr key={index}>{row.map((value,col)=><td key={col}>{display(value)}</td>)}</tr>)}</tbody></table></div>:<p>暂无已保存记录。</p>}
  </Surface>)}
  {attachments.length>0&&<Surface><h3>关联附件</h3><ul>{attachments.map(attachment=><li key={attachment.attachmentId}>{attachment.filename}{" · "}<a href={apiUrl(`tools/attachments/${attachment.attachmentId}/download?mode=preview`)} target="_blank" rel="noreferrer">预览</a>{" · "}<a href={apiUrl(`tools/attachments/${attachment.attachmentId}/download?mode=download`)} target="_blank" rel="noreferrer">下载</a></li>)}</ul></Surface>}
 </div>;
}
