import {BulkWashingPanel} from './bulk-washing-panel.js';
import {GarmentQualityForm} from './garment-quality-form.js';
import {OriginalGarmentQualityPhotos} from './garment-quality-photos.js';
import {closureFeedbackProjection} from './document-feedback-projections.js';
import {SubmissionAttempt} from './submission-attempt.js';
import {SubmissionRequestError} from './submission-validation.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {useEffect,useRef,useState} from 'react';
import {Button,Surface} from '@dx-rework/ui';
import type {OrderClosureSheet} from '@dx-rework/contracts/order-closure';
import {DigitalRequestError,digitalRequest} from './digital-production-api.js';
import {createClientRequestId} from './client-request-id.js';
import {createWebUrls} from '../url-contract.js';
import {ReceivingOriginalRecord,readReceivingOriginalSearch} from './receiving-original-records.js';
import {qualityRecordTarget} from './quality-workbench-route.js';
import './factory-flow-panel.css';
export function closureWorkQuantityLabel(r:OrderClosureSheet['lines'][number]['reworks'][number]){
 return r.businessSummary?.kind==='inhouse_finishing'?`普通做尾 · 原单登记量 ${r.quantity??'尚未记录'}（不作为不良返工量）`:r.businessSummary?.kind==='qc_rework'?`不良返工 · 原单登记返工量 ${r.quantity??'尚未记录'}`:`原单登记量 ${r.quantity??'尚未记录'} · 业务类型待原单核实`;
}
const reworkStatus=(value:string)=>({draft:'草稿',pending_process_configuration:'待分配工序与工人',pending_ie_review:'待IE核价',pending_task_assignment:'待启动执行',in_progress:'工序执行中',pending_order_review:'待尾部核量',pending_final_quantity_ie_review:'最终数量待IE复核',pending_quantity_adjustment_ie_review:'数量调整待IE',pending_responsibility_determination:'待责任判定',pending_owner_signature:'待老板签字',pending_responsibility_action:'责任处理中',completed:'已完成',cancelled:'已取消'} as Record<string,string>)[value]??'请查看原单';
const urls=createWebUrls(import.meta.env.BASE_URL);
export async function closureRequest(path:string,method='GET',body?:unknown,key?:string):Promise<OrderClosureSheet>{
 const value=await digitalRequest<OrderClosureSheet>(path,method,body,key),orderId=path.match(/^orders\/([^/]+)\/closure/)?.[1];
 const valid=closureFeedbackProjection.safeParse(value).success&&value.orderId===orderId;
 if(!valid||method!=='GET'&&(value.stage!=='特殊结案'||!value.closed||value.closed.reason!==(body as {reason:string}).reason.trim()))throw new DigitalRequestError(method==='GET'?'原回货及结案资料尚未取得完整回执，请重新读取':'原结案提交结果尚未确认，请保留原因并核对原提交',200,'INVALID_RESPONSE');
 return value;
}
type Props={orderId:string;onClose:()=>void};
export function OrderClosurePanel(props:Props){
 const target=readReceivingOriginalSearch(window.location.search);
 return target===undefined?<CurrentOrderClosurePanel {...props}/>:<ReceivingOriginalRecord {...props} target={target}/>;
}
function CurrentOrderClosurePanel({orderId,onClose}:Props){
 const base=`orders/${orderId}/closure`,[sheet,setSheet]=useState<OrderClosureSheet|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),writing=useRef(false),pending=useRef<{payload:string;key:string}|null>(null);
 const attempt=useRef(new SubmissionAttempt()),contextVersion=useRef(0);const [uncertain,setUncertain]=useState(false);
 useDigitalDetailNavigationGuard(uncertain,busy,writing,'原结案提交结果尚未确认，离开不会撤销提交并会丢失原标识。仍要离开？');
 const motherReturn=`/ui/digital-production?order=${orderId}`;
 const reload=async()=>{const context=contextVersion.current;const value=await closureRequest(base);if(context===contextVersion.current)setSheet(value);};
 useEffect(()=>{let live=true;contextVersion.current++;setSheet(null);setError('');setUncertain(false);attempt.current=new SubmissionAttempt();pending.current=null;writing.current=false;setBusy(false);void closureRequest(base).then(s=>{if(live)setSheet(s);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;contextVersion.current++;};},[base]);
 const close=async(reason:string,recover=false)=>{
  if(writing.current||!sheet||uncertain&&!recover)return;writing.current=true;setBusy(true);setError('');
  const context=contextVersion.current,operation=attempt.current,body={reason,expectedRevision:sheet.revision},payload=JSON.stringify(body);if(!recover&&pending.current?.payload!==payload)pending.current={payload,key:createClientRequestId()};const originalKey=pending.current?.key;
  const execute=async()=>{try{const value=await closureRequest(base,'POST',body,originalKey);operation.markConfirmed();if(context===contextVersion.current){setSheet(value);pending.current=null;setUncertain(false);}}catch(error){if(error instanceof DigitalRequestError&&!error.resultUnknown)throw new SubmissionRequestError(error.message,error.code,error.status??500);throw error;}};
  try{const result=recover?await operation.retry():await operation.run(execute);if(context!==contextVersion.current)return;if(result.kind==='failure'){setUncertain(result.uncertain);setError(result.failure.message+(result.uncertain?'；原结案结果待确认，请使用原内容核对，不要修改原因后另提。':''));}else if(result.kind==='expired')setError('原结案提交已超过安全恢复期限，请核对本单结案记录，不再重发。');}
  finally{if(context===contextVersion.current){writing.current=false;setBusy(false);}}
 };
 useEffect(()=>{if(!sheet)return;const id=window.location.hash.slice(1);if(!/^receipt-[0-9a-f-]{36}$/.test(id))return;const target=document.getElementById(id);if(target){const detail=target.closest("details");if(detail)detail.open=true;target.scrollIntoView({block:"center"});}},[sheet]);
 const target=qualityRecordTarget(new URLSearchParams(window.location.search));
 if(target?.kind==='garment'){
  const actual=sheet?.quality?.find(row=>row.receiptId===target.receiptId&&row.quantityVersion===target.quantityVersion&&row.quantity>0);
  const po=sheet?.lines.find(line=>line.lineId===actual?.lineId);
  return <Surface className="factory-flow"><div className="pattern-actions"><Button onClick={onClose}>返回来源</Button>
   <Button onClick={()=>void reload().catch(e=>setError(e.message))}>刷新原实绩</Button></div><h2>成衣到仓检查</h2>
   {error&&<p role="alert">{error}</p>}{!sheet&&!error&&<p role="status">正在读取原实收及检查…</p>}
   {sheet&&!actual&&<p role="alert">本批实收或数量版本已变化，请返回质量中心重新读取。</p>}
   {actual&&<section aria-label="本批原质检"><h3>{po?.poNumber??'PO 待核'} · {po?.color??'颜色待核'}</h3>
    <p>本批实收 {actual.quantity} 件 · {actual.inspected?`已检查，合格 ${actual.qualifiedQuantity}`:'待检查'}</p>
    {sheet?.canRecordQuality&&!sheet.closed?<GarmentQualityForm key={`${actual.receiptId}:${actual.quantityVersion}`} orderId={orderId} receipt={actual}
     canVerify={sheet.canVerifyQualityTime===true} onSaved={reload}/>:<><p>{actual.problem}</p><OriginalGarmentQualityPhotos orderId={orderId} receipt={actual}/></>}
   </section>}
  </Surface>;
 }
 return <Surface className="factory-flow"><div className="pattern-actions"><Button disabled={busy} onClick={onClose}>返回</Button><Button disabled={busy} onClick={()=>void reload().catch(e=>setError(e.message))}>刷新原实绩</Button></div><h2>回货、返工与本期结案</h2><BulkWashingPanel orderId={orderId}/>{error&&<p role="alert">{error}</p>}{uncertain&&<><p role="status">原结案提交回执仍未确认，刷新原实绩不等于撤销或确认该提交。</p><Button disabled={busy} onClick={()=>void close("",true)}>使用原内容核对结案提交</Button></>}{sheet?<><h3>{sheet.stage}</h3>{sheet.collection&&<p>{sheet.collection.status} · 应收 {sheet.collection.expected} · 有效实收 {sheet.collection.received} · 未收 {sheet.collection.remaining}{sheet.collection.excess>0?` · 超收 ${sheet.collection.excess}`:''} · 装箱/出货 {sheet.collection.shipmentQuantity??'待核'}{sheet.collection.shipmentQuantity===null&&sheet.collection.unknownPackingLineCount?`（已核${sheet.collection.knownShipmentQuantity??0}，另有${sheet.collection.unknownPackingLineCount}个PO待核）`:''}</p>}<details><summary>收齐与出货口径</summary><p>收齐仅表示累计有效实收达到母单应收，质检、装箱及差异仍分别办理。出货数量直接采用有效装箱记录；客户签收仍为未知。</p>{sheet.receivingSpan&&<p>{sheet.receivingSpan.elapsedHours!==null?`首笔有效实收到收齐 ${sheet.receivingSpan.elapsedHours.toFixed(1)} 小时`:sheet.receivingSpan.reason??'尚未收齐，历时待完成'}</p>}{sheet.receivingSpan?.history.map((h,i)=><p key={i}>{new Date(h.recordedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} · {h.state} · 当时有效实收 {h.received}{h.cause==='correction'?'（数量更正）':''}</p>)}{sheet.receivingForecast?.state!=='collected'&&sheet.receivingForecast&&<p>{sheet.receivingForecast.range?`预计收齐日期范围 ${new Date(sheet.receivingForecast.range.fromInclusive).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'})}—${new Date(Date.parse(sheet.receivingForecast.range.toExclusive)-1).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'})}`:sheet.receivingForecast.reason}</p>}</details><a href={`${urls.pageUrl('ui/digital-production')}?factory=${orderId}`}>查看实际发厂与船样到料</a>{sheet.canOpenWages&&<p><a href={urls.pageUrl('ui/wages')}>原工资台账</a>（是否已发工资不阻断本期结案）</p>}
 {sheet.lines.map(l=><section key={l.lineId} id={`line-${l.lineId}`}><h3>{l.poNumber??'待补PO'} · {l.color}</h3><p>订购 {l.orderedQuantity} · 累计实收 {l.actualQuantity} · 原送货单 {l.documentQuantity} · 次品 {l.defectiveQuantity}</p><p>原收货 {l.receiptCount} 次 · 原装箱 {l.packingQuantity??'待核'}</p>{sheet.canOpenReceiving&&l.receivingBatchId&&<p><a href={`${urls.pageUrl('ui/orders')}?${new URLSearchParams({receivingBatchId:l.receivingBatchId,returnTo:motherReturn})}`}>查看本 PO 回货、差异及装箱</a></p>}{l.receivingResolution&&<p>当前收货差异处理：{l.receivingResolution}</p>}{l.packingResolution&&<p>当前装箱差异处理：{l.packingResolution}</p>}{sheet.quality?.filter(q=>q.lineId===l.lineId).map(q=><div key={q.receiptId}><p>本批实收 {q.quantity} · {q.inspected?`已检查，合格 ${q.qualifiedQuantity}`:'到仓检查待办理'}</p>{sheet.canRecordQuality?<GarmentQualityForm orderId={orderId} receipt={q} canVerify={sheet.canVerifyQualityTime===true} onSaved={reload}/>:<>{q.problem&&<p>{q.problem}</p>}<OriginalGarmentQualityPhotos orderId={orderId} receipt={q}/></>}</div>)}<details><summary>原收货事实</summary>{l.receipts.map(r=><p key={r.receiptId} id={`receipt-${r.receiptId}`}>{r.precision==='date'?`${r.receivedDate??'日期未知'}（仅日期）`:r.receivedAt?new Date(r.receivedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'实际时间未知'} · 本次实收 {r.actualQuantity} · 次品 {r.defectiveQuantity}</p>)}<p>累计数沿用原收货模块，包含Root更正和原合并调整。</p></details>{l.reworks.map(r=><div key={r.reworkId}><p>{r.canView===true?<a href={`${urls.pageUrl(`ui/tasks/${r.reworkId}`)}?${new URLSearchParams({returnTo:motherReturn})}`}>{r.reworkNo??'原返工草稿'}</a>:r.reworkNo??'原返工草稿'} · 原状态 {reworkStatus(r.status)} · {closureWorkQuantityLabel(r)}</p><p>{r.problem}</p>{r.businessSummary?.processes.map(process=><p key={process.configurationItemId}>{process.processName} · {process.reportedQuantity===null?'尚无本工序有效报量':`本工序有效报量 ${process.reportedQuantity} 件`}</p>)}{r.businessSummary&&<small>各工序分别核对，不相加为整单件数；原登记量、有效报量、最终核量分别保留。</small>}<p>原工资台账关联 {r.wageItemCount} 条</p></div>)}</section>)}
 <details><summary>当前未清事项（{sheet.outstanding.length}）</summary>{sheet.outstanding.length?<ul>{sheet.outstanding.map((s,i)=><li key={i}>{s}</li>)}</ul>:<p>当前未见未清事项。</p>}</details>{sheet.closed&&<section><h3>特殊结案记录</h3><p>{sheet.closed.closedBy} · {new Date(sheet.closed.closedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</p><p>{sheet.closed.reason}</p><h4>结案时未清事项</h4><ul>{sheet.closed.outstanding.map((s,i)=><li key={i}>{s}</li>)}</ul><p>原质量、差异及工资记录继续按原流程处理，结案未将其标记为已解决。</p></section>}
 {sheet.canClose&&<form onSubmit={e=>{e.preventDefault();void close(String(new FormData(e.currentTarget).get('reason')??''));}}><fieldset disabled={busy||uncertain}><legend>特殊结案</legend><p>核对以上原实绩及未清事项后，可对短装或余量取消作例外决定。结案保存原因和当时未清事项，结束未完成的本期数字待办，原数量和原业务问题保留。</p><label>具体结案原因 *<textarea name="reason" required maxLength={2000}/></label><label> *<input type="checkbox" required/>已核对原实绩及全部未清事项</label><Button type="submit">确认特殊结案</Button></fieldset></form>}
 </>:<p>{error?"原回货及装箱事实尚未读取，请刷新原实绩。":"正在读取原回货及装箱事实…"}</p>}</Surface>;
}
