import {beginForegroundWait} from "../foreground-loading.js";
import { exceptionRecordHref } from "./exception-presentation.js";
import { canAccessFinance } from "../finance-access.js";
import { verifySession } from "../auth.js";
import { formatBusinessDecimal, isBusinessMoneyField } from "@dx-rework/contracts/business-display";
import { fixedBusinessCurrency } from "../fixed-business-currency.js";
import { ReportTypeSchema, type ReportPreviewResponse, type ReportType } from "@dx-rework/contracts/reporting";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useRef, useState } from "react";

import { businessFieldLabel, businessValue, formatBusinessTime } from "../business-display.js";
import { Header, Shell } from "../components.js";
import { ListPagination, usePaginatedItems } from "../list-pagination.js";
import { loadReport, downloadReportExport, reportingBusinessDate, reportingBusinessMonthStart } from "./reporting-client.js";
import "./reporting.css";

const names: Record<ReportType,string>={rework_overview:"返工总览",wages:"工资明细",responsibilities:"责任明细",own_factory:"本厂承担",external_deductions:"外部扣款",exceptions:"异常明细"};
const statuses:Record<ReportType,readonly (readonly [string,string])[]>={
  rework_overview:[["","全部状态"],["draft","草稿"],["pending_process_configuration","待配置工序"],["pending_ie_review","待 IE 审核"],["pending_task_assignment","待分工"],["in_progress","上数中"],["pending_order_review","待尾部确认最终数量"],["pending_final_quantity_ie_review","最终数量待 IE 复核"],["pending_quantity_adjustment_ie_review","数量调整待 IE"],["pending_responsibility_determination","责任判定与资料核验"],["pending_owner_signature","待老板确认签字"],["pending_responsibility_action","责任结算中"],["completed","订单已完成"],["cancelled","已取消"]],
  wages:[["","全部状态"],["unsettled","未结算"],["settled","已结算"]],
  responsibilities:[["","全部责任"],["own_factory","本厂承担"],["processing_factory","加工厂"],["embroidery_factory","印绣花厂"],["washing_factory","洗水厂"],["fabric_supplier","面料商"]],
  own_factory:[["","全部状态"],["pending","待审批"],["approved","已通过"],["rejected","已驳回"]],
  external_deductions:[["","全部状态"],["pending_business_signoff","待业务签收"],["pending_payables_confirmation","待应付确认"],["deduction_follow_up","扣款跟进"],["pending_special_approval","待财务总监特批"],["returned","已退回"],["pending_responsibility_revision","责任变更中"],["closed","已关闭"],["superseded","已被新版本替代"],["full","全额"],["partial","部分"],["not_deducted","未扣"],["over_deducted","超额扣款（已特批）"]],
  exceptions:[["","全部异常"],["overdue_todo","待办逾期"],["blocked_recipient","接收人失效"],["todo_delivery_failed","投递失败"],["deduction_follow_up_overdue","扣款跟进逾期"]],
};
type State={kind:"loading"}|{kind:"ready";value:ReportPreviewResponse;type:ReportType;key:string}|{kind:"unavailable";message:string;retryable?:boolean};
const snapshotBusinessValue = (key: string, value: Parameters<typeof businessValue>[1]): string =>
  value !== null && value !== undefined && value !== "" && isBusinessMoneyField(key)
    ? fixedBusinessCurrency(String(value)) : businessValue(key, value);

export function ReportCenterPage(){
  const [wageAccess,setWageAccess]=useState<boolean|null>(null);
  useEffect(()=>{let mounted=true;void verifySession().then(session=>{if(mounted)setWageAccess(session!=="denied"&&session.status==="authorized"&&canAccessFinance(session.user));});return()=>{mounted=false;};},[]);
  const initial=useMemo(()=>new URLSearchParams(window.location.search),[]);
  const parsed=ReportTypeSchema.safeParse(initial.get("type"));
  const [type,setType]=useState<ReportType>(parsed.success?parsed.data:"rework_overview");
  const [from,setFrom]=useState(initial.get("from")??reportingBusinessMonthStart());
  const [to,setTo]=useState(initial.get("to")??reportingBusinessDate());
  const [q,setQ]=useState(initial.get("q")??"");
  const [status,setStatus]=useState(initial.get("status")??"");
  const [state,setState]=useState<State>({kind:"loading"});
  const [revision,setRevision]=useState(0),[reading,setReading]=useState(true);
  const pendingRead=useRef(false),manualRetry=useRef(false);
  const retry=()=>{
   if(pendingRead.current||manualRetry.current)return;
   manualRetry.current=true;setRevision(value=>value+1);
  };
  const [exportBusy,setExportBusy]=useState(false),[exportNotice,setExportNotice]=useState(''),[exportError,setExportError]=useState('');
  const exportRun=useRef(0),exportRequest=useRef<AbortController|null>(null);
  const filters=useMemo(()=>({from,to,q:q.trim()||undefined,status:status||undefined,limit:"100"}),[from,to,q,status]);
  const reportKey=JSON.stringify([type,filters]),reportAccess=type!=="wages"?true:wageAccess;
  useEffect(()=>{
   if(reportAccess!==true){
    if(reportAccess===false){setState({kind:"unavailable",message:"当前账号无权查看工资明细"});setReading(false);}
    return;
   }
   const controller=new AbortController(),finish=beginForegroundWait();
   pendingRead.current=true;manualRetry.current=false;setReading(true);
   void loadReport(type,filters,controller.signal).then(value=>{
    if(!controller.signal.aborted)setState({kind:"ready",value,type,key:reportKey});
   }).catch((error:unknown)=>{
    if(controller.signal.aborted)return;
    setState({kind:"unavailable",message:error instanceof Error?error.message:"报表加载失败",retryable:true});
   }).finally(()=>{
    finish();
    if(!controller.signal.aborted){pendingRead.current=false;setReading(false);}
   });
   return()=>{controller.abort();finish();pendingRead.current=false;};
  },[reportKey,reportAccess,revision]);
  useEffect(()=>{exportRun.current++;exportRequest.current?.abort();setExportBusy(false);setExportNotice('');setExportError('');return()=>{exportRun.current++;exportRequest.current?.abort();};},[type,filters]);
  const download=async()=>{
   if(exportRequest.current&&!exportRequest.current.signal.aborted)return;
   const controller=new AbortController(),version=++exportRun.current;exportRequest.current=controller;setExportBusy(true);setExportError('');setExportNotice('');
   try{const file=await downloadReportExport(type,filters,controller.signal);if(version!==exportRun.current)return;const objectUrl=URL.createObjectURL(file.blob),link=document.createElement('a');link.href=objectUrl;link.download=file.filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(objectUrl),1000);setExportNotice('已收到导出文件，浏览器正在处理下载；请查看下载列表。');}
   catch(error){if(version===exportRun.current&&(error as Error)?.name!=='AbortError')setExportError(error instanceof Error?error.message:'导出文件尚未取得，请在原筛选范围重试读取');}
   finally{if(version===exportRun.current){exportRequest.current=null;setExportBusy(false);}}
  };
  const value=state.kind==="ready"&&state.type===type&&(type!=="wages"||wageAccess===true)?state.value:null;
  const page=usePaginatedItems(value?.rows??[],state.kind==="ready"?state.key:reportKey);
  return <Shell active="财务报表"><div className="report-center-layout"><Header title="财务报表" subtitle="查询返工、工资、责任和扣款明细" badge={value?`${formatBusinessDecimal(value.rowCount)} 行 · ${value.range.from} 至 ${value.range.to}`:"查询中"} />
    <Surface className="reporting-filters report-center-filters">
      <label>报表<select value={type} onChange={event=>{setType(ReportTypeSchema.parse(event.target.value));setStatus("");}}>{ReportTypeSchema.options.filter(item=>item!=="wages"||wageAccess===true).map(item=><option value={item} key={item}>{names[item]}</option>)}</select></label>
      <label>开始日期<input type="date" value={from} onChange={event=>setFrom(event.target.value)} /></label>
      <label>结束日期<input type="date" value={to} onChange={event=>setTo(event.target.value)} /></label>
      <label>状态/类型<select value={status} onChange={event=>setStatus(event.target.value)}>{statuses[type].map(([item,label])=><option value={item} key={item}>{label}</option>)}</select></label>
      <InsetField label="关键词" value={q} onChange={event=>setQ(event.target.value)} placeholder="单号 / 款号 / 人员 / 供应商" />
      {value?.canExport && <Button variant="primary" disabled={exportBusy||reading||state.kind!=="ready"||state.key!==reportKey} onClick={()=>void download()}>{exportBusy?"正在读取导出文件…":"导出 Excel"}</Button>}
    </Surface>
    {exportError&&<Surface><p role="alert">{exportError}</p></Surface>}{exportNotice&&<p role="status">{exportNotice}</p>}
    {reading&&!value&&<Surface className="reporting-state"><p role="status">正在生成报表…</p></Surface>}
    {!reading&&state.kind==="unavailable"&&<Surface className="reporting-state"><p role="alert">{state.message}</p>{state.retryable?<Button onClick={retry}>重试读取报表</Button>:null}</Surface>}
    {value&&<>
      <Surface className="reporting-summary"><div><h2>{names[type]}</h2><p>{formatBusinessTime(value.asOf)}</p></div><div>{Object.entries(value.totals).map(([key,total])=><StatusBadge tone="info" key={key}>{businessFieldLabel(key)}：{snapshotBusinessValue(key, total)}</StatusBadge>)}</div></Surface>
      <Surface className="reporting-table-surface"><div className="reporting-table-wrap" tabIndex={0} role="region" aria-label="财务报表明细，可横向滚动"><table><thead><tr>{value.columns.map(column=><th key={column.key} scope="col">{column.label}</th>)}</tr></thead><tbody>{page.items.map((row,index)=><tr key={index}>{value.columns.map(column=><td key={column.key} className={isBusinessMoneyField(column.key)?"reporting-money":undefined}>{column.key === "settlementStatus" ? (row[column.key] === "settled" ? "已结算" : "未结算") : type === "exceptions" && column.key === "deepLink" ? exceptionRecordHref(row[column.key],import.meta.env.BASE_URL) ? <a className="reporting-exception-link" href={exceptionRecordHref(row[column.key],import.meta.env.BASE_URL)!}>查看原记录</a> : "记录不可用" : snapshotBusinessValue(column.key, row[column.key])}</td>)}</tr>)}</tbody></table></div>{value.rows.length===0&&<p>当前筛选范围没有数据。</p>}{value.truncated&&<StatusBadge tone="warning">预览达到 100 行上限；Excel 最多可导出 50,000 行。</StatusBadge>}<ListPagination page={page.page} totalPages={page.totalPages} onPageChange={page.setPage} ariaLabel="财务报表分页" /></Surface>
    </>}
  </div></Shell>;
}
