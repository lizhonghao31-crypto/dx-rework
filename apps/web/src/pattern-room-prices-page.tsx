import {beginForegroundWait,useForegroundWait} from "./foreground-loading.js";
import {feedbackFetch,feedbackJson} from './request-response-feedback.js';
import {SubmissionAttempt} from './submission-attempt.js';
import {SubmissionRequestError} from './submission-validation.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import { PatternField as InsetField } from "./pattern-controls.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { z } from "zod";
import { Button, Surface } from "@dx-rework/ui";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { PatternPriceChangeSchema, PatternPriceHistorySchema, PatternPriceItemSchema, PatternPricesSchema, type PatternPriceItem } from "@dx-rework/contracts/pattern-room";
import { Header } from "./components.js";
import { createWebUrls } from "../url-contract.js";
import { createClientRequestId } from "./client-request-id.js";
import { useInternalReturnScroll } from "./use-internal-return-scroll.js";
import "./system-dialog.css";
import "./pattern-room.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
const time = (value: string) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
const amountText = (value: string | null) => value === null ? "未配置" : formatBusinessDecimal(value, 3);
async function readPrice<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const response=await feedbackFetch(apiUrl(path),{...init,credentials:'include',cache:'no-store',headers:{'content-type':'application/json',...init.headers}});
  return feedbackJson(response,init.method??'GET',value=>schema.parse(value),(message,code,status)=>new SubmissionRequestError(message,code,status));
}
function PriceDialog({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose(): void; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className="system-dialog pattern-price-dialog" aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>{children}</dialog>;
}

export function PatternRoomPricesPage() {
  const [data, setData] = useState<z.infer<typeof PatternPricesSchema> | null>(null), [error, setError] = useState("");
  const [editing, setEditing] = useState<PatternPriceItem | null>(null), [amount, setAmount] = useState(""), [enabled, setEnabled] = useState(true), [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false), [formError, setFormError] = useState("");
  const [history, setHistory] = useState<{ item: PatternPriceItem; rows: z.infer<typeof PatternPriceHistorySchema> } | null>(null);
  const submission=useRef(new SubmissionAttempt()),writing=useRef(false);const [uncertain,setUncertain]=useState(false);useDigitalDetailNavigationGuard(uncertain,busy,writing,"原价格调整结果尚未确认；离开不会撤销操作，请先核对原价格记录。仍要离开？");
  const attempt = useRef<{ body: string; priceId: string; key: string } | null>(null);
  useInternalReturnScroll(data !== null);
  const refresh = async () => { setData(await readPrice("pattern-room/prices", PatternPricesSchema)); setError(""); };
  useForegroundWait(!data&&!error?"pattern-prices:entry":undefined);
  const historyRequest=useRef<{id:string;controller:AbortController;finish:()=>void}|null>(null);
  useEffect(()=>()=>{historyRequest.current?.controller.abort();historyRequest.current?.finish();},[]);
  useEffect(() => { const abort = new AbortController(); void readPrice("pattern-room/prices", PatternPricesSchema, { signal: abort.signal }).then(setData).catch(e => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "价格读取失败"); }); return () => abort.abort(); }, []);
  const edit = (item: PatternPriceItem) => {if(uncertain||writing.current)return;submission.current=new SubmissionAttempt(); setEditing(item); setAmount(item.amount ?? ""); setEnabled(item.enabled); setReason(""); setFormError(""); attempt.current = null; };
  const showHistory = async (item: PatternPriceItem) => {
    if(historyRequest.current?.id===item.priceId)return;
    historyRequest.current?.controller.abort();
    historyRequest.current?.finish();
    const controller=new AbortController(),read={id:item.priceId,controller,finish:beginForegroundWait()};
    historyRequest.current=read;
    try {
      const rows=await readPrice(`pattern-room/prices/${item.priceId}/history`,PatternPriceHistorySchema,{signal:controller.signal});
      if(historyRequest.current===read&&!controller.signal.aborted)setHistory({item,rows});
    }catch(e){
      if(historyRequest.current===read&&!controller.signal.aborted)setError(e instanceof Error?e.message:"价格记录读取失败");
    }finally{
      if(historyRequest.current===read)historyRequest.current=null;
      read.finish();
    }
  };
  const save = async (recover=false) => {
    if(!editing||busy||writing.current||uncertain&&!recover)return;
    const parsed=PatternPriceChangeSchema.safeParse({version:editing.version,amount,enabled,reason});
    if(!recover&&!parsed.success){setFormError(parsed.error.issues[0]?.message??'请检查价格与调整原因');return;}
    const body=JSON.stringify(parsed.data);
    if(!recover&&(attempt.current?.body!==body||attempt.current.priceId!==editing.priceId))attempt.current={body,priceId:editing.priceId,key:createClientRequestId()};
    const command=attempt.current;if(!command)return;
    writing.current=true;setBusy(true);setFormError('');const operation=submission.current;
    const execute=async()=>{const changed=await readPrice(editing.kind==='hourly'?'pattern-room/prices/hourly':`pattern-room/prices/categories/${command.priceId}`,PatternPriceItemSchema,{method:'POST',body:command.body,headers:{'idempotency-key':command.key}});const expected=JSON.parse(command.body) as {version:number;amount:string;enabled:boolean};if(changed.priceId!==command.priceId||changed.version!==expected.version+1||changed.amount!==expected.amount||changed.kind!==editing.kind||changed.enabled!==expected.enabled)throw new SubmissionRequestError('原价格提交尚未取得匹配回执，请沿原内容核对','INVALID_RESPONSE',200);operation.markConfirmed();setUncertain(false);setEditing(null);attempt.current=null;try{await refresh();}catch(error){setError('价格调整已保存，最新价格尚未读取；请仅重新读取。'+(error instanceof Error?error.message:''));}};
    try{const result=recover?await operation.retry():await operation.run(execute);
     if(result.kind==='failure'){setUncertain(result.uncertain);setFormError(result.failure.message+(result.uncertain?'；原价格提交结果待确认，请使用原内容核对，不要另改价格。':''));}
     else if(result.kind==='expired')setFormError('原价格提交已超过安全恢复期限，请在原价格记录核对，不再重发。');
    }finally{writing.current=false;setBusy(false);}
  };
  return <div className="pattern-prices"><Header title="价格管控" badge="订单打板" badgePlacement="subtitle" />
    {error ? <Surface><p role="alert">{error}</p><Button onClick={() => void refresh().catch(e => setError(e instanceof Error ? e.message : "价格读取失败"))}>重新读取</Button></Surface> : null}
    {!data && !error ? <p role="status">正在读取价格…</p> : null}
    {data ? <>
      <Surface><h2>打板品类单价</h2><p>调整后仅对新订单生效。</p>
        <div className="pattern-price-table reporting-table-wrap"><table><thead><tr><th>品类</th><th>单位</th><th>单价（元）</th><th>状态</th><th>最近调整</th><th>操作</th></tr></thead><tbody>
          {data.categories.map(item => <tr key={item.priceId}><th scope="row">{item.name}</th><td data-label="单位">{item.unit}</td><td data-label="单价（元）">{amountText(item.amount)}</td><td data-label="状态">{item.enabled ? "启用" : "停用"}</td>
            <td data-label="最近调整">{item.updatedBy ?? "初始化"}<small>{time(item.updatedAt)}</small></td><td data-label="操作"><div className="pattern-price-actions"><Button onClick={() => void showHistory(item)}>价格记录</Button>{data.canWriteCategories ? <Button onClick={() => edit(item)}>调整</Button> : null}</div></td></tr>)}
        </tbody></table></div>
      </Surface>
      <Surface><h2>杂事小时单价</h2><p className="pattern-hourly-price">{amountText(data.hourly.amount)}{data.hourly.amount !== null ? " 元/小时" : ""}</p>
        {data.hourly.amount === null ? <p>请由老板或 root 配置后再提交杂事订单。</p> : <p>最近调整：{data.hourly.updatedBy ?? "初始化"} · {time(data.hourly.updatedAt)}</p>}
        <Button onClick={() => void showHistory(data.hourly)}>价格记录</Button>{" "}{data.canWriteHourly ? <Button onClick={() => edit(data.hourly)}>调整小时单价</Button> : null}
      </Surface>
    </> : null}
    {editing ? <PriceDialog title={`调整${editing.name}`} busy={busy||uncertain} onClose={() => setEditing(null)}><form className="pattern-order-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <h2>调整{editing.name}</h2><p>当前价格：{amountText(editing.amount)} 元/{editing.unit}</p>
      <InsetField label={`新单价（元/${editing.unit}）`} inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} disabled={busy||uncertain} autoFocus />
      {editing.kind === "category" ? <label className="pattern-checkbox"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={busy||uncertain} />启用此品类</label> : null}
      <InsetField label="调整原因（必填）" value={reason} onChange={event => setReason(event.target.value)} maxLength={500} disabled={busy||uncertain} />
      {uncertain&&<><Button type="button" disabled={busy} onClick={()=>void save(true)}>使用原内容核对价格调整</Button><Button type="button" disabled={busy} onClick={()=>void showHistory(editing)}>只查看原价格记录</Button></>}
      {formError ? <div><p role="alert">{formError}</p><Button type="button" disabled={busy||uncertain} onClick={() => { setEditing(null); void refresh().catch(e => setError(e instanceof Error ? e.message : "价格读取失败")); }}>重新读取价格</Button></div> : null}
      <div className="system-dialog__actions"><Button type="button" disabled={busy||uncertain} onClick={() => setEditing(null)}>取消</Button><Button variant="primary" type="submit" disabled={busy||uncertain}>{busy ? "保存中…" : "保存"}</Button></div>
    </form></PriceDialog> : null}
    {history ? <PriceDialog title={`${history.item.name}价格记录`} onClose={() => setHistory(null)}><div className="pattern-price-history"><h2>{history.item.name}价格记录</h2>
      {history.rows.map(row => <section key={row.version}><strong>{row.version === 1 ? "初始化" : `${amountText(row.oldAmount)} →`} {amountText(row.amount)} 元/{history.item.unit}</strong>
        <p>{row.enabled ? "启用" : "停用"} · {row.changedBy ?? "初始化"} · {time(row.changedAt)}</p><p>{row.reason}</p></section>)}
      <Button onClick={() => setHistory(null)}>关闭</Button></div></PriceDialog> : null}
  </div>;
}
