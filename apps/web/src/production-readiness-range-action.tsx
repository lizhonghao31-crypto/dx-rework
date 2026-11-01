import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {confirmInApp} from './system-dialog.js';
import {SubmissionAttempt} from './submission-attempt.js';
import {SubmissionRequestError} from './submission-validation.js';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {createClientRequestId} from './client-request-id.js';
import {useRef,useState} from 'react';
import {Button} from '@dx-rework/ui';
import type {BulkPreparationSheet} from '@dx-rework/contracts/bulk-preparation';
/** Uses the existing task command. Partial work does not set either whole-order completion fact. */
export function BulkPreparationRangeAction({sheet,busy,onSaved}:{sheet:BulkPreparationSheet;busy:boolean;onSaved:(next:BulkPreparationSheet)=>void}){
 const [kind,setKind]=useState<'纸样完成'|'唛架完成'>('纸样完成'),[whole,setWhole]=useState(false),[selected,setSelected]=useState<string[]>(sheet.cutting.lines.map(l=>l.lineId)),[pending,setPending]=useState<string[]>([]),[note,setNote]=useState(''),[touched,setTouched]=useState(false);
 const writing=useRef(false),attempt=useRef(new SubmissionAttempt()),[saving,setSaving]=useState(false),[error,setError]=useState(''),[receipt,setReceipt]=useState('');
 const disabled=busy||saving||attempt.current.hasPending;
 const readiness=sheet.readiness;
 const prior=readiness?.ranges.filter(r=>r.preparationId===sheet.preparationId&&r.kind===kind).at(-1);
 const same=(a:string[],b:string[])=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
 const dirty=touched&&(!prior||prior.note!==note||prior.complete!==whole||!same(prior.lineIds,selected)||!same(prior.pendingMaterialIds,pending));
 useDigitalDetailNavigationGuard(dirty,disabled,writing,'本次准备范围尚未保存，确认离开？');
 const submit=async(retry=false)=>{
  if(writing.current||busy)return;
  const body={preparationId:sheet.preparationId,kind,expectedReadinessRevision:readiness?.revision,range:{expectedVersion:prior?.version??0,lineIds:[...selected],complete:whole,pendingMaterialIds:whole?[]:[...pending],note,evidenceIds:[]}},key=createClientRequestId();
  writing.current=true;setSaving(true);setError('');setReceipt('');
  const operation=async()=>{try{const next=await digitalRequest<BulkPreparationSheet>(`orders/${sheet.orderId}/bulk-preparation/complete`,'POST',body,key);attempt.current.markConfirmed();setTouched(false);onSaved(next);setReceipt('已保存实际准备范围');}catch(error){if(error instanceof DigitalRequestError&&!error.resultUnknown)throw new SubmissionRequestError(error.message,error.code,error.status??500);throw error;}};
  try{const result=retry?await attempt.current.retry():await attempt.current.run(operation);if(result.kind==='failure')setError(result.failure.message);if(result.kind==='needs-recovery')setError('上次结果尚未确认，请使用原内容核对');if(result.kind==='expired')setError('原请求已超过安全恢复窗口，请管理员核对，不重复新增');}finally{writing.current=false;setSaving(false);}
 };
 if(!readiness)return null;
 return <details className="preparation-range-action"><summary>登记纸样 / 唛架实际准备范围</summary><fieldset disabled={disabled}><legend>登记实际准备范围</legend><label>成果<select value={kind} onChange={e=>{const next=e.target.value as typeof kind;void (async()=>{if(dirty&&!await confirmInApp('切换成果会放弃本次未保存说明，确认切换？'))return;setKind(next);setNote('');setPending([]);setWhole(false);setTouched(false);})();}}><option>纸样完成</option><option>唛架完成</option></select></label>
 <p>普通单及急单均可先做不受欠辅料影响的部分。原任务沿相应制单起点和本单面板时限计时，派工、补料及同范围换版不重置；完成后的新补做未明确期限时显示未设置。</p>
 <div>{sheet.cutting.lines.map(l=><label className="preparation-range-choice" key={l.lineId}><input type="checkbox" checked={selected.includes(l.lineId)} onChange={e=>{setTouched(true);setSelected(ids=>e.target.checked?[...ids,l.lineId]:ids.filter(id=>id!==l.lineId));}}/>{l.poNumber??'待补PO'} · {l.color}</label>)}</div>
 <label className="preparation-range-choice"><input type="checkbox" checked={whole} onChange={e=>{setTouched(true);setWhole(e.target.checked);}}/>本项全部适用款色均已完成，且不再欠本项物料</label>
 {!whole&&sheet.materials?.items.length? <fieldset><legend>仍需补料后复核 / 补做</legend>{sheet.materials.items.map(m=><label className="preparation-range-choice" key={m.id}><input type="checkbox" checked={pending.includes(m.id)} onChange={e=>{setTouched(true);setPending(ids=>e.target.checked?[...ids,m.id]:ids.filter(id=>id!==m.id));}}/>{m.name} · {m.specification}</label>)}</fieldset>:null}
 <label>本次已做范围及待补做说明<textarea value={note} maxLength={1000} onChange={e=>{setTouched(true);setNote(e.target.value);}}/></label>
 <Button disabled={!note.trim()||!selected.length||sheet.facts.some(f=>f.kind===kind)} onClick={()=>void submit()}>{whole?`确认整单${kind}`:'保存局部准备，不放行整单'}</Button>
 {readiness.ranges.some(r=>r.preparationId!==sheet.preparationId)&&<details><summary>前版准备范围（供本轮复核，不自动完成本轮）</summary>{readiness.ranges.filter(r=>r.preparationId!==sheet.preparationId).map(r=><p key={r.rangeId}>{r.kind} · {r.note}</p>)}</details>}
 {readiness.ranges.filter(r=>r.preparationId===sheet.preparationId).map(r=><p key={r.rangeId}>{r.kind} · 第{r.version}次 · {r.complete?'全部适用范围已完成':'局部准备，尚未完成整单'} · {r.note}</p>)}</fieldset>{receipt&&<p role="status">{receipt}</p>}{error&&<p role="alert">{error}</p>}{attempt.current.hasPending&&<Button disabled={saving||busy} onClick={()=>void submit(true)}>使用原内容核对范围提交结果</Button>}</details>;
}
