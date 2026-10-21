import {DevelopmentExecutionTransferSchema,type DevelopmentArrangement} from '@dx-rework/contracts/development-arrangement';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {confirmInApp} from './system-dialog.js';
export type DevelopmentTransferContext={sourceId:string;plan:DevelopmentArrangement};
import {DevelopmentMakingUpgradeFields,makingUpgradeFromForm} from './development-making-upgrade.js';
import {DEVELOPMENT_REVISION_NODES,DEVELOPMENT_PROBLEM_CATEGORIES,type DevelopmentRevision} from "@dx-rework/contracts/digital-development-rounds";
import { PatternDialog } from "./pattern-dialog.js";
import { PatternMaterials, type PatternMaterial } from "./pattern-materials.js";
import { SearchSelect } from "./search-select.js";
import { PatternField as InsetField } from "./pattern-controls.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@dx-rework/ui";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { CancelPatternOrderSchema, PatternOrderDetailSchema, PatternRoundActionSchema, PatternWorkerOptionsSchema, RequestPatternReworkSchema, TransferPatternOrderSchema, type PatternOrderDetail } from "@dx-rework/contracts/pattern-orders";
import type { z } from "zod";
import { createClientRequestId } from "./client-request-id.js";
import { patternRequest, uploadPatternOriginal } from "./pattern-order-client.js";
import { useDebouncedValue } from "./use-debounced-value.js";
import { PatternMaterialInput, PATTERN_MATERIAL_LIMIT } from "./pattern-material-input.js";

export type PatternExceptionAction = "rework" | "transfer" | "cancel" | "cancel-fees";
const titles = { rework: "发起原单返工", transfer: "原单换人", cancel: "取消本次任务", "cancel-fees": "确认取消费用" };
export function PatternOrderExceptions({ order, active, onActive, busy, onBusy, onSaved,developmentContext }: { developmentContext?:DevelopmentTransferContext|undefined;order: PatternOrderDetail; active: PatternExceptionAction | null; onActive(action: PatternExceptionAction | null): void; busy: boolean; onBusy(value: boolean): void; onSaved(order: PatternOrderDetail): void }) {
  const [reason, setReason] = useState(""), [category, setCategory] = useState("customer_change"), [amount, setAmount] = useState(""), [hours, setHours] = useState("");
  const [personId, setPersonId] = useState(""), [searchText, setSearchText] = useState(""), [workers, setWorkers] = useState<z.infer<typeof PatternWorkerOptionsSchema>>([]);
  const [files, setFiles] = useState<PatternMaterial[]>([]), [uploading, setUploading] = useState(false), [error, setError] = useState("");
  const [transferReceiptNotice,setTransferReceiptNotice]=useState('');
  const [uncertainTransfer,setUncertainTransfer]=useState(false),writing=useRef(false);
  const disabled = busy || uploading||uncertainTransfer;
  useDigitalDetailNavigationGuard(uncertainTransfer,busy||uploading,writing,'原换人提交结果尚未确认，离开不会撤销已发出的操作，且会丢失本页重试记录。仍要离开？');
  const [developmentNodes,setDevelopmentNodes]=useState<DevelopmentRevision["affectedNodes"]>([]),[developmentProblems,setDevelopmentProblems]=useState<DevelopmentRevision["categories"]>([]);
  const [retained, setRetained] = useState<PatternMaterial[]>([]);
  const attempt = useRef<{ body: string; action: string; key: string } | null>(null), search = useDebouncedValue(searchText.trim(), 250);
  const round = order.rounds.find(item => item.roundId === order.currentRoundId)!, segment = round.segments.at(-1);
  const pending = order.status === "pending_assignment", fixedMisc = order.kind === "misc" && round.completedAt !== null && round.actualHours != null;
  useEffect(() => {
    if(uncertainTransfer)return;
    setRetained(order.attachments.filter(file => file.roundId === order.currentRoundId && file.active));
    setDevelopmentNodes([]);setDevelopmentProblems([]);setReason(""); setAmount(""); setHours(""); setPersonId(""); setSearchText(""); setFiles([]); setError(""); attempt.current = null;
  }, [active, order.currentRoundId, order.attachments]);
  useEffect(() => {
    if (active !== "transfer") return;
    const abort = new AbortController();
    void patternRequest(`workers?q=${encodeURIComponent(search)}`, PatternWorkerOptionsSchema, { signal: abort.signal }).then(setWorkers).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [active, search]);
  const upload = async (selected: File[]) => {
    if (disabled || !selected.length) return;
    if (selected.length + files.length + retained.length > PATTERN_MATERIAL_LIMIT) { setError("本轮资料合计最多20份，请先移除不需要的资料"); return; }
    setUploading(true); onBusy(true); setError("");
    try {
      for (const file of selected) {
        const result = await uploadPatternOriginal(file, "pattern", "rework");
        setFiles(current => [...current, { attachmentId: result.attachmentId, filename: result.filename, mimeType: result.mimeType }]);
      }
    } catch (e) { setError(e instanceof Error ? e.message : "附件上传失败"); }
    finally { setUploading(false); onBusy(false); }
  };
  const close=async()=>{if(uncertainTransfer&&!await confirmInApp('换人提交结果尚未确认，关闭不会撤销操作。可稍后重新打开本页核对，仍要关闭？'))return;onActive(null);};
  const recoverTransfer=async(retry=false)=>{
    if(writing.current||!developmentContext||!attempt.current)return;
    writing.current=true;onBusy(true);setError('');
    const prior=attempt.current,path=`sources/${developmentContext.sourceId}/execution/transfer-execution`;
    try{
      const found=await digitalRequest<{receipt:unknown|null;committedVersion?:number|null}>(`${path}/receipt?key=${encodeURIComponent(prior.key)}`);
      if(found.receipt){const current=PatternOrderDetailSchema.parse(found.receipt);setTransferReceiptNotice(found.committedVersion!==null&&found.committedVersion!==undefined&&found.committedVersion!==current.version?'本次换人已有回执，之后又有新的办理；当前显示最新人员和执行段。':'本次换人已确认，人员安排和执行段已同步。');setUncertainTransfer(false);onSaved(current);onActive(null);return;}
      if(!retry){setError('尚未查到本次换人回执，结果仍未确认；请稍后核对，或沿原标识重试本次提交。');return;}
      const result=PatternOrderDetailSchema.parse(await digitalRequest(path,'POST',JSON.parse(prior.body),prior.key));
      setUncertainTransfer(false);onSaved(result);onActive(null);
    }catch(reason){setError(`原换人结果仍未确认；本次核对／重试提示：${reason instanceof Error?reason.message:'服务暂未响应'}。请保留本页操作标识核对，不要换内容重复提交。`);}
    finally{writing.current=false;onBusy(false);}
  };
  const sendDevelopmentTransfer=async(input:unknown)=>{
    if(writing.current||!developmentContext)return;
    const row=developmentContext.plan.rows.find(row=>row.kind==='development_sewing');
    const parsed=DevelopmentExecutionTransferSchema.safeParse({...input as object,orderId:order.orderId,roundNumber:developmentContext.plan.roundNumber,expectedDocumentVersion:developmentContext.plan.documentVersion,expectedArrangementVersion:developmentContext.plan.version,expectedTask:row?.taskId?{taskId:row.taskId,state:row.state,assigneeId:row.assigneeId}:null});
    if(!parsed.success){setError(parsed.error.issues[0]?.message??'请核对本轮换人资料');return;}
    const body=JSON.stringify(parsed.data);if(attempt.current?.body!==body||attempt.current.action!=='transfer')attempt.current={body,action:'transfer',key:createClientRequestId()};
    writing.current=true;onBusy(true);setError('');
    try{const result=PatternOrderDetailSchema.parse(await digitalRequest(`sources/${developmentContext.sourceId}/execution/transfer-execution`,'POST',parsed.data,attempt.current.key));onSaved(result);onActive(null);}
    catch(reason){const unknown=!(reason instanceof DigitalRequestError)||reason.resultUnknown;setUncertainTransfer(unknown);setError(unknown?`${reason instanceof Error?reason.message+'；':''}尚未确认换人是否成功。本页已保留原请求和操作标识，请先核对回执；不会把未知结果当成未换人。`:reason.message);}
    finally{writing.current=false;onBusy(false);}
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!active || busy || uploading) return;
    const basis = { version: order.version, roundId: order.currentRoundId };
    const input = active === "rework" ? RequestPatternReworkSchema.safeParse({ ...basis, reason, reasonCategory: category,...(order.developmentSourceId?{developmentNodes,developmentProblems,...(order.developmentMakingBasis?.needsUpgrade?{developmentMaking:makingUpgradeFromForm(new FormData(event.currentTarget as HTMLFormElement),order.developmentMakingBasis)}:{})}:{}), retainedAttachmentIds: retained.map(file => file.attachmentId), attachmentIds: files.map(file => file.attachmentId) })
      : active === "transfer" ? TransferPatternOrderSchema.safeParse({ ...basis, segmentId: segment?.segmentId, personId, reason, ...(order.kind === "misc" ? { hours } : { amount }) })
      : active === "cancel" ? CancelPatternOrderSchema.safeParse({ ...basis, reason, ...(!pending ? { segmentId: segment?.segmentId, ...(order.kind === "pattern" ? { amount } : fixedMisc ? {} : { hours }) } : {}) })
      : PatternRoundActionSchema.safeParse(basis);
    if (!input.success) { setError(input.error.issues[0]?.message ?? "请填写必要信息"); return; }
    if(active==='transfer'&&developmentContext){await sendDevelopmentTransfer(input.data);return;}
    const body = JSON.stringify(input.data);
    if (attempt.current?.body !== body || attempt.current.action !== active) attempt.current = { body, action: active, key: createClientRequestId() };
    onBusy(true); setError("");
    try {
      const result = await patternRequest(`orders/${order.orderId}/${active}`, PatternOrderDetailSchema, { method: "POST", body, headers: { "idempotency-key": attempt.current.key } });
      onSaved(result); onActive(null);
    } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    finally { onBusy(false); }
  };
  if(!active&&uncertainTransfer)return <section role="status"><p>原换人结果尚未确认，暂不开始另一笔执行操作。</p><Button type="button" disabled={busy||uploading} onClick={()=>onActive('transfer')}>核对未确认换人</Button></section>;
  if (!active) return <div className="pattern-actions">{transferReceiptNotice&&<p role="status">{transferReceiptNotice}</p>}
    {order.actions.rework ? <Button disabled={disabled} onClick={() => onActive("rework")}>发起原单返工</Button> : null}
    {order.actions.transfer ? <Button disabled={disabled} onClick={() => onActive("transfer")}>原单换人</Button> : null}
    {order.actions.cancel ? <Button disabled={disabled} onClick={() => onActive("cancel")}>取消任务</Button> : null}
    {order.actions.cancelFees ? <Button disabled={disabled} onClick={() => onActive("cancel-fees")}>确认取消费用</Button> : null}
  </div>;
  return <PatternDialog title={titles[active]} busy={busy||uploading} onClose={()=>void close()}><form className="pattern-exception pattern-order-form" onSubmit={event => void submit(event)}><h3>{titles[active]}</h3>
    {active === "rework" ? <>
      <label>返工原因分类<select className="rework-v2-control" disabled={disabled} value={category} onChange={e => setCategory(e.target.value)}><option value="customer_change">客户修改要求</option><option value="workmanship">制作不符合要求</option><option value="other">其他</option></select></label>

      {order.developmentSourceId&&<><p>本次同时建立原打板工作轮与数字开发局部复版；工资仍按主管明确核定的原工作轮金额。</p><fieldset><legend>受影响工序</legend>{DEVELOPMENT_REVISION_NODES.map(node=><label key={node} className="pattern-rework-node-choice"><input type="checkbox" disabled={disabled} checked={developmentNodes.includes(node)} onChange={event=>setDevelopmentNodes(current=>event.target.checked?[...current,node]:current.filter(value=>value!==node))}/>{node}</label>)}</fieldset><fieldset><legend>问题分类</legend>{DEVELOPMENT_PROBLEM_CATEGORIES.map(node=><label key={node} className="pattern-rework-node-choice"><input type="checkbox" disabled={disabled} checked={developmentProblems.includes(node)} onChange={event=>setDevelopmentProblems(current=>event.target.checked?[...current,node]:current.filter(value=>value!==node))}/>{node}</label>)}</fieldset></>}
      <DevelopmentMakingUpgradeFields basis={order.developmentMakingBasis} disabled={disabled}/><PatternMaterialInput kind="pattern" purpose="rework" count={files.length + retained.length} label="补充图片 / PDF" disabled={disabled} onFiles={selected => void upload(selected)} />
      <PatternMaterials files={[...retained, ...files]} disabled={disabled} onRemove={id => { setRetained(current => current.filter(file => file.attachmentId !== id)); setFiles(current => current.filter(file => file.attachmentId !== id)); }} />
    </> : null}
    {active === "transfer" ? <label>接手师傅<div className="rework-v2-control"><SearchSelect options={workers.filter(worker => worker.userId !== segment?.workerUserId).map(worker => ({ value: worker.personId, label: worker.name }))} value={personId} onChange={setPersonId} onSearchChange={setSearchText} placeholder="输入姓名选择师傅" ariaLabel="接手师傅" emptyText="没有匹配的师傅" disabled={disabled} /></div></label> : null}
    {active === "transfer" || (active === "cancel" && !pending) ? <>
      <p>当前执行人：{segment?.workerName}。{order.kind === "pattern" ? `当前段金额 ${formatBusinessDecimal(segment?.amount ?? "0", 2)} 元；以前执行段保留。` : "按本单保存的小时价计算每段实际劳动。"}</p>
      {order.kind === "pattern" ? <InsetField label={active === "transfer" ? "原工人应得部分（元，无实际制作填0）" : "当前工人取消部分费用（元，无费用填0）"} inputMode="decimal" required value={amount} disabled={disabled} onChange={e => setAmount(e.target.value)} />
        : active === "cancel" && fixedMisc ? <p>工时与完工已确定，本次保留既有计薪事实。</p>
        : <InsetField label="当前执行段已做工时（小时，无实际工作填0）" inputMode="decimal" required value={hours} disabled={disabled} onChange={e => setHours(e.target.value)} />}
    </> : null}
    {active === "cancel" ? <p>{pending ? "取消未派工请求，保留历史轮次。" : "确认工作已经停止。打板有费用时，仍由原设计师确认取消费用。"}</p> : null}
    {active === "cancel-fees" ? <><p>请核对以下取消费用，确认后计入工资，订单仍为已取消。</p>{order.rounds.filter(item => item.cancelledAmount != null && /[1-9]/.test(item.cancelledAmount) && item.feeConfirmedAt === null).map(item => <p key={item.roundId}>{item.index === 0 ? "首次打板" : `第${item.index}次返工`}：{formatBusinessDecimal(item.cancelledAmount!, 2)} 元</p>)}</>
      : <label>{active === "rework" ? "返工内容 / 原因（必填）" : "操作说明（必填）"}<textarea className="rework-v2-control" required maxLength={active === "rework" ? 2000 : 500} disabled={disabled} value={reason} onChange={e => setReason(e.target.value)} /></label>}
    {error ? <p role="alert">{error}</p> : null}{uncertainTransfer&&<section><p>请保留原请求：{attempt.current?.key}</p><Button type="button" disabled={busy||uploading} onClick={()=>void recoverTransfer()}>核对原换人回执</Button><Button type="button" disabled={busy||uploading} onClick={()=>void recoverTransfer(true)}>沿原标识重试换人</Button></section>}{uploading ? <p role="status">正在上传原始资料…</p> : null}
    <div className="rework-v2-action-area"><div className="rework-v2-actions"><Button type="button" disabled={busy||uploading} onClick={()=>void close()}>{uncertainTransfer?"关闭，结果待核对":"暂不提交"}</Button><Button type="submit" variant="primary" disabled={disabled}>{busy ? "提交中…" : titles[active]}</Button></div></div>
  </form></PatternDialog>;
}
