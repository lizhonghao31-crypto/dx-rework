import {useEffect,useRef,useState} from 'react';
import {normalizeSampleMoneyFields} from './sample-money-input.js';
import {z} from 'zod';
import {SampleDisposalActionsSchema,SampleMaintenanceResultSchema,SampleFinancialAuditResponseSchema,type SampleView} from '@dx-rework/contracts';
import {Button,Surface} from '@dx-rework/ui';
import {SampleImageUpload,SamplePersonPicker} from './sample-create-page.js';
import {readSampleAction,useSampleSubmit} from './sample-workflow-page.js';
import {verifySession} from './auth.js';
import {ListPagination} from './list-pagination.js';
import {createWebUrls} from '../url-contract.js';
const {pageUrl,apiUrl}=createWebUrls(import.meta.env.BASE_URL);
export function SampleDisposalActions({item}:{item:SampleView}){
 const [data,setData]=useState<z.infer<typeof SampleDisposalActionsSchema>|null>(null),[error,setError]=useState(''),[type,setType]=useState('scrap'),[reason,setReason]=useState(''),[recipient,setRecipient]=useState(''),[amount,setAmount]=useState(''),[responsible,setResponsible]=useState(''),[location,setLocation]=useState(item.storageLocation??'');
 const activeUploaders=useRef(0);
 const [pendingUploads,setPendingUploads]=useState<Record<string,number>>({});
 const hasPendingUploads=Object.values(pendingUploads).some(count=>count>0);
 const onPendingUpload=(key:string,count:number)=>setPendingUploads(current=>({...current,[key]:count}));
 const onUploadBusy=(busy:boolean)=>{activeUploaders.current=Math.max(0,activeUploaders.current+(busy?1:-1));setUploading(activeUploaders.current>0);};
 const [receiptMode,setReceiptMode]=useState<'append'|'replace'>('append');
 const [financeAmount,setFinanceAmount]=useState(item.finance?.purchasePrice??''),[financeFiles,setFinanceFiles]=useState<{attachmentId:string;filename:string}[]>([]);
 const [files,setFiles]=useState<{attachmentId:string;filename:string}[]>([]),[uploading,setUploading]=useState(false),[basic,setBasic]=useState({brand:item.brand,styleName:item.styleName,color:item.color,department:item.department,styleNo:item.styleNo,category:item.category,size:item.size,remark:item.remark}),action=useSampleSubmit();
 useEffect(()=>{const abort=new AbortController();void readSampleAction(`samples/${item.sampleId}/disposal-actions`,SampleDisposalActionsSchema,{signal:abort.signal}).then(v=>{if(!abort.signal.aborted)setData(v);}).catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'操作加载失败');});return()=>abort.abort();},[item.sampleId,item.version]);
 const send=async(path:string,fields:Record<string,unknown>)=>{
  if(action.busy||uploading||hasPendingUploads)return;
  setError('');
  try{
   const input=normalizeSampleMoneyFields(fields);
   if(await action.send(`samples/${item.sampleId}/${path}`,{version:item.version,...input},SampleMaintenanceResultSchema))window.dispatchEvent(new Event('sample-updated'));
  }catch(e){setError(e instanceof Error?e.message:'请检查输入资料');}
 };
 if(!data)return error?<p role="alert">{error}</p>:null;if(!data.enabled)return null;
 const disabled=action.busy||uploading||hasPendingUploads,proofAttachmentIds=files.map(f=>f.attachmentId),moneyRequired=['sale','loss'].includes(data.pending?.type??'');
 return <Surface className="rework-v2-core sample-action-section"><h2>处置与资料维护</h2>{error||action.error?<p role="alert">{error||action.error}</p>:null}
  {data.pending?<p>待处理处置：{({sale:'出售',gift:'赠送',scrap:'报废',loss:'遗失'})[data.pending.type]}{data.pending.recipient?` · 接收对象：${data.pending.recipient}`:''}{data.pending.responsibleName?` · 责任人：${data.pending.responsibleName}`:''}{data.pending.reason?` · ${data.pending.reason}`:''}</p>:null}
  {data.canRequest?<details><summary>发起处置</summary><div className="rework-v2-grid"><label>处置类型<select value={type} disabled={disabled} onChange={e=>{setType(e.target.value);setFiles([]);}}>{item.status==='in_stock'?<><option value="sale">出售</option><option value="gift">赠送</option></>:null}<option value="scrap">报废</option>{item.status==='borrowed'?<option value="loss">遗失</option>:null}</select></label>
   {['sale','gift'].includes(type)?<label>接收对象<input value={recipient} disabled={disabled} onChange={e=>setRecipient(e.target.value)}/></label>:<label>原因说明<input value={reason} disabled={disabled} onChange={e=>setReason(e.target.value)}/></label>}
   {type==='sale'?<label>出售金额<input inputMode="decimal" value={amount} disabled={disabled} onChange={e=>setAmount(e.target.value)}/></label>:null}
   {type==='loss'?<SamplePersonPicker endpoint="samples/disposal-people" label="遗失责任人" value={responsible} onChange={setResponsible} disabled={disabled}/>:<SampleImageUpload label="上传处置证明" value={files} onChange={setFiles} disabled={action.busy||uploading} onBusy={onUploadBusy} onPending={count=>onPendingUpload("proof",count)}/>}
   <Button disabled={disabled||(type!=='loss'&&!files.length)} onClick={()=>{void send('disposal-request',type==='loss'?{type,reason,responsibleUserId:responsible}:type==='scrap'?{type,reason,proofAttachmentIds}:{type,recipient,proofAttachmentIds,...(type==='sale'?{amount}:{})});}}>提交处置申请</Button>
  </div></details>:null}
  {data.canApprove?<details open><summary>处置审批</summary>{data.pending?.proposedAmount?<p>参考金额：¥{data.pending.proposedAmount}</p>:null}{moneyRequired?<label>最终{data.pending?.type==='loss'?'赔偿':'出售'}金额<input inputMode="decimal" value={amount} disabled={disabled} onChange={e=>setAmount(e.target.value)}/></label>:null}<label>审批说明（拒绝时必填）<input value={reason} disabled={disabled} onChange={e=>setReason(e.target.value)}/></label>
   <Button disabled={disabled||(moneyRequired&&!amount.trim())} onClick={()=>{void send('disposal-decision',{decision:'approve',...(moneyRequired?{finalAmount:amount}:{}),...(reason.trim()?{reason}:{})});}}>批准处置</Button><Button disabled={disabled||!reason.trim()} onClick={()=>{void send('disposal-decision',{decision:'reject',reason});}}>拒绝申请</Button></details>:null}
  {data.canCloseLoss?<details open><summary>确认遗失赔付</summary><p>应收赔偿：¥{data.pending?.finalAmount}。确认收到付款后上传凭证并结案。</p><SampleImageUpload label="上传付款截图" value={files} onChange={setFiles} disabled={action.busy||uploading} onBusy={onUploadBusy} onPending={count=>onPendingUpload("proof",count)}/><Button disabled={disabled||!files.length} onClick={()=>{void send('loss-close',{proofAttachmentIds});}}>已收到赔付，确认结案</Button></details>:null}
  {data.canUpdateBasic?<details><summary>修改基本资料</summary><div className="rework-v2-grid">{(Object.entries({brand:'品牌',styleName:'样衣名称',color:'颜色',department:'部门',styleNo:'款号',category:'类别',size:'尺码',remark:'备注'}) as [keyof typeof basic,string][]).map(([key,label])=><label key={key}>{label}<input value={basic[key]} disabled={disabled} onChange={e=>setBasic(v=>({...v,[key]:e.target.value}))}/></label>)}<label>修改原因<input value={reason} disabled={disabled} onChange={e=>setReason(e.target.value)}/></label><Button disabled={disabled||!reason.trim()} onClick={()=>{void send('basic',{...basic,reason});}}>保存基本资料</Button></div></details>:null}
  {data.canUpdateLocation?<details><summary>修改在库位置</summary><label>位置<input value={location} disabled={disabled} onChange={e=>setLocation(e.target.value)}/></label><label>修改原因<input value={reason} disabled={disabled} onChange={e=>setReason(e.target.value)}/></label><Button disabled={disabled||!location.trim()||!reason.trim()} onClick={()=>{void send('location',{storageLocation:location,reason});}}>保存位置</Button></details>:null}
  {data.canCorrectFinance?<details><summary>修改采购资料与追加小票</summary><p>采购价修改与小票操作均记录操作人、时间和原因，原始附件及历史永久保留。</p>{data.canReplaceReceipts?<label>小票处理方式<select value={receiptMode} disabled={disabled} onChange={e=>{setReceiptMode(e.target.value as 'append'|'replace');setFinanceFiles([]);}}><option value="append">追加小票，保留当前有效小票</option><option value="replace">更正有效小票集合（仅管理员）</option></select></label>:null}{data.canReplaceReceipts&&receiptMode==='replace'?<p>请上传本次全部有效小票；原有效小票将退出当前列表，仍可在财务变更记录中查阅。</p>:<p>本次追加不会撤下原有小票。</p>}<label>采购价<input value={financeAmount} inputMode="decimal" disabled={disabled} onChange={e=>setFinanceAmount(e.target.value)}/></label><SampleImageUpload label={data.canReplaceReceipts&&receiptMode==='replace'?'上传全部正确小票':'追加采购小票'} value={financeFiles} onChange={setFinanceFiles} disabled={action.busy||uploading} onBusy={onUploadBusy} onPending={count=>onPendingUpload("finance",count)}/><label>修改原因<input value={reason} disabled={disabled} onChange={e=>setReason(e.target.value)}/></label><Button disabled={disabled||!reason.trim()||!financeAmount.trim()||(data.canReplaceReceipts&&receiptMode==='replace'&&!financeFiles.length)} onClick={()=>{void send('finance-correction',{purchasePrice:financeAmount,receiptAttachmentIds:financeFiles.map(f=>f.attachmentId),receiptMode:data.canReplaceReceipts?receiptMode:'append',reason});}}>保存采购资料</Button></details>:null}
  {data.canArchive||data.canRestore?<details><summary>{data.canRestore?'恢复样衣':'归档样衣'}</summary><p>{data.canRestore?'恢复原业务状态，待处理事项将重新进入待办。':'归档后退出正常列表及金额统计，历史记录保留。'}</p><label>原因<input value={reason} disabled={disabled} onChange={e=>setReason(e.target.value)}/></label><Button disabled={disabled||!reason.trim()} onClick={()=>{void send(data.canRestore?'restore':'archive',{reason});}}>确认{data.canRestore?'恢复':'归档'}</Button></details>:null}
 </Surface>;
}
const archiveSchema=z.object({page:z.number(),totalCount:z.number(),items:z.array(z.object({sampleId:z.string(),sampleCode:z.string(),styleName:z.string(),reason:z.string()}))});
export function SampleArchiveList(){
 const [root,setRoot]=useState(false),[open,setOpen]=useState(false),[page,setPage]=useState(1),[data,setData]=useState<z.infer<typeof archiveSchema>|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0);
 useEffect(()=>{let active=true;void verifySession().then(s=>{if(active&&typeof s==='object'&&s.status==='authorized')setRoot(!!s.user.isRoot);});return()=>{active=false;};},[]);
 useEffect(()=>{const update=()=>setRefresh(n=>n+1);window.addEventListener('sample-updated',update);return()=>window.removeEventListener('sample-updated',update);},[]);
 useEffect(()=>{if(!root||!open)return;const abort=new AbortController();setBusy(true);void readSampleAction(`samples/archived?page=${page}`,archiveSchema,{signal:abort.signal}).then(v=>{if(!abort.signal.aborted){setData(v);setError('');}}).catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'归档读取失败');}).finally(()=>{if(!abort.signal.aborted)setBusy(false);});return()=>abort.abort();},[root,open,page,refresh]);
 if(!root)return null;return <Surface className="rework-v2-core"><details onToggle={e=>setOpen(e.currentTarget.open)}><summary>管理员归档记录</summary>{error?<p role="alert">{error}</p>:null}{data?.items.map(i=><p key={i.sampleId}><a href={pageUrl(`ui/samples/${i.sampleId}`)}>{i.sampleCode} · {i.styleName}</a> · {i.reason}</p>)}{data?<ListPagination page={page} totalPages={Math.max(1,Math.ceil(data.totalCount/15))} busy={busy} onPageChange={setPage} ariaLabel="归档样衣分页"/>:null}</details></Surface>;
}

export function SampleFinancialHistory({sampleId}:{sampleId:string}){
 const [data,setData]=useState<z.infer<typeof SampleFinancialAuditResponseSchema>|null>(null),[page,setPage]=useState(1),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{const abort=new AbortController();setBusy(true);void readSampleAction(`samples/${sampleId}/financial-audit?page=${page}`,SampleFinancialAuditResponseSchema,{signal:abort.signal}).then(v=>{if(!abort.signal.aborted)setData(v);}).catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'财务历史读取失败');}).finally(()=>{if(!abort.signal.aborted)setBusy(false);});return()=>abort.abort();},[sampleId,page]);
 const labels:Record<string,string>={'sample.created':'建档','sample.imported':'历史迁入','sample.finance_corrected':'采购资料更正','sample.disposal_requested':'申请处置','sample.disposal_approved':'处置审批','sample.loss_closed':'遗失赔付结案'};
 return <Surface className="rework-v2-core"><details><summary>财务资料变更记录</summary>{error?<p role="alert">{error}</p>:null}{data?.items.map(entry=><article className="sample-history-entry" key={entry.eventId}><strong>{labels[entry.action]??'财务资料变更'} · {entry.actorName}</strong><p>{new Date(entry.occurredAt).toLocaleString('zh-CN')}{entry.reason?` · ${entry.reason}`:''}</p>
  {(['purchasePrice','proposedAmount','finalAmount'] as const).map(key=>typeof entry.after[key]==='string'?<p key={key}>{({purchasePrice:'采购价',proposedAmount:'参考金额',finalAmount:'最终处置金额'})[key]}：{typeof entry.before?.[key]==='string'?`¥${entry.before[key]} → `:''}¥{String(entry.after[key])}</p>:null)}
  {(['before','after'] as const).map(state=>Array.isArray(entry[state]?.receiptAttachmentIds)?<p key={state}>{state==='before'?'原小票':'本次小票'}：{(entry[state]!.receiptAttachmentIds as unknown[]).filter((id):id is string=>typeof id==='string').map((id,n)=><a key={id} href={apiUrl(`samples/${sampleId}/attachments/${id}/download`)} target="_blank" rel="noreferrer">查看第 {n+1} 张 </a>)}</p>:null)}
 </article>)}{data?<ListPagination page={page} totalPages={Math.max(1,Math.ceil(data.totalCount/15))} busy={busy} onPageChange={setPage} ariaLabel="财务变更记录分页"/>:null}</details></Surface>;
}
