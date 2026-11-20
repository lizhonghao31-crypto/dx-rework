import {feedbackFetch,feedbackJson} from "../request-response-feedback.js";
import { AuthGate } from "../auth.js";
import { financePageRequirements } from "../finance-access.js";
import {
  WagePeriodDetailSchema,
  WagePeriodDetailPageSchema,
} from "@dx-rework/contracts/wages";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { fixedBusinessCurrency as formatBusinessCurrency } from "../fixed-business-currency.js";
import { Button, InsetField, Surface } from "@dx-rework/ui";
import {useCallback,useEffect,useState} from "react";
import {ListPagination} from "../list-pagination.js";
import {useLiveSearch} from "../use-live-search.js";
import {useForegroundRead} from "../use-foreground-read.js";
import {useForegroundWait} from "../foreground-loading.js";

import { createWebUrls } from "../../url-contract.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
export async function readWagePeriodDetail(periodId:string){
 const response=await feedbackFetch(apiUrl(`wage-periods/${periodId}`),{credentials:"include",headers:{accept:"application/json"}});
 return feedbackJson(response,"GET",value=>WagePeriodDetailSchema.parse(value));
}

export function WagePeriodDetailPage({ periodId }: { periodId: string }) {
  return <AuthGate requiredAnyOf={financePageRequirements}><WagePeriodDetailContent periodId={periodId} /></AuthGate>;
}

function WagePeriodDetailContent({ periodId }: { periodId: string }) {
  const [selection,setSelection]=useState({periodId,page:1}),[q,setQ]=useState(""),[search,setSearch]=useState("");
  const page=selection.periodId===periodId?selection.page:1,setPage=(page:number)=>setSelection({periodId,page});
  const live=useLiveSearch(q,search,value=>{setSearch(value);setPage(1);});
  const read=useCallback(async(signal:AbortSignal)=>{
    const response=await feedbackFetch(apiUrl(`wage-periods/${periodId}?`+new URLSearchParams({page:String(page),q:search})),
      {credentials:"include",headers:{accept:"application/json"},signal});
    return feedbackJson(response,"GET",value=>WagePeriodDetailPageSchema.parse(value));
  },[periodId,page,search]);
  const report=useForegroundRead(periodId,JSON.stringify([page,search]),read,true);
  useForegroundWait(q.trim()===search?report.foregroundKey:undefined);
  const detail=report.value,message=report.error?.message??"",load=report.retry;
  useEffect(()=>{
    if(report.waiting||!detail)return;
    const lastPage=Math.max(1,Math.ceil(detail.totalCount/15));
    if(detail.page>lastPage)setSelection({periodId,page:lastPage});
  },[detail,periodId,report.waiting]);

  const period=detail?.period,items=detail?.items??[];
  return (
    <div className="wage-page wage-period-detail">
      <header className="page-heading">
        <div>
          <h1>返工工资对数明细</h1>
          {period&&<p>工资期间：{period.periodMonth.slice(0, 7)}</p>}
        </div>
      </header>

      <Surface><InsetField label="搜索本期工资明细" value={q} type="search" onChange={event=>setQ(event.target.value)} onCompositionStart={live.onCompositionStart} onCompositionEnd={live.onCompositionEnd} placeholder="工人 / 返工单 / 款号 / 工序" />{detail&&<p>{formatBusinessDecimal(detail.totalCount)} 条当前结果</p>}</Surface>
      {!detail&&<Surface><p role={message?"alert":"status"}>{message||"正在读取工资明细…"}</p>{message&&<Button disabled={report.waiting} onClick={load}>重新读取工资详情</Button>}</Surface>}
      {period&&<Surface className="wage-summary">
        <dl>
          <dt>工人 / 明细</dt><dd>{formatBusinessDecimal(period.personCount)} / {formatBusinessDecimal(period.sourceItemCount)}</dd>
          <dt>工资总额</dt><dd><strong>{formatBusinessCurrency(period.totalAmount)}</strong></dd>
        </dl>
        <div className="wage-actions">
          {period.canExport ? (
            <a href={apiUrl(`wage-periods/${period.periodId}/export.xlsx`)} download className="wage-export-link">
              <Button>导出 Excel</Button>
            </a>
          ) : null}
        </div>
      </Surface>}

      {detail&&message && <p role="alert" className="form-message">{message}<Button onClick={()=>{void load();}}>重新读取工资详情</Button></p>}


      {detail&&items.length===0&&<p>当前条件没有工资明细。</p>}
      <section className="wage-grid">
        {items.map((item) => (
          <Surface key={item.wageItemId} className="wage-item-card">
            <h2>{item.personNameSnapshot} · 应付 {formatBusinessCurrency(item.payableAmount)}</h2>
            <p>{item.supplierNameSnapshot} · {item.personTypeSnapshot === "temporary" ? "临时工" : "正式工"} · {item.reworkNoSnapshot} · {item.styleNoSnapshot}</p>
            <p>{item.processNameSnapshot} · {formatBusinessDecimal(item.actualQuantitySnapshot)} {item.pricingUnitSnapshot === "piece" ? "件" : "小时"} · 基础单价 {formatBusinessCurrency(item.unitPriceSnapshot)}</p>
            <p>工资系数 ×{formatBusinessDecimal(item.temporaryWageMultiplier, 3)} · 应付金额 {formatBusinessCurrency(item.payableAmount)}</p>
            <p>{item.assignmentMode === "collective" ? "集体计件" : "个人计件"} · 组总额 {formatBusinessCurrency(item.groupAmount)}</p>
            <details className="wage-calculation-detail">
              <summary>查看分摊计算</summary>
              <p>个人分摊原值 {formatBusinessDecimal(item.exactPersonShare, 4)} · 尾差顺序 {item.remainderRank}/{item.memberCount}</p>
            </details>
          </Surface>
        ))}
      </section>
      {detail&&<ListPagination page={detail.page} totalPages={Math.max(1,Math.ceil(detail.totalCount/15))} onPageChange={setPage} ariaLabel="工资期间明细分页" />}

    </div>
  );
}
