import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {confirmInApp} from './system-dialog.js';
import {useRef,useState} from 'react';
import {Button} from '@dx-rework/ui';
import type {BulkPreparationSheet} from '@dx-rework/contracts/bulk-preparation';
/** Uses the existing task command. Partial work does not set either whole-order completion fact. */
export function BulkPreparationRangeAction({sheet,busy,save}:{sheet:BulkPreparationSheet;busy:boolean;save:(path:string,input:unknown)=>Promise<void>}){
 const [kind,setKind]=useState<'纸样完成'|'唛架完成'>('纸样完成'),[whole,setWhole]=useState(false),[selected,setSelected]=useState<string[]>(sheet.cutting.lines.map(l=>l.lineId)),[pending,setPending]=useState<string[]>([]),[note,setNote]=useState(''),[touched,setTouched]=useState(false);
 const writing=useRef(false);writing.current=busy;
 const readiness=sheet.readiness;
 const prior=readiness?.ranges.filter(r=>r.preparationId===sheet.preparationId&&r.kind===kind).at(-1);
 const same=(a:string[],b:string[])=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
 const dirty=touched&&(!prior||prior.note!==note||prior.complete!==whole||!same(prior.lineIds,selected)||!same(prior.pendingMaterialIds,pending));
 useDigitalDetailNavigationGuard(dirty,busy,writing,'本次准备范围尚未保存，确认离开？');
 if(!readiness)return null;
 return <details className="preparation-range-action"><summary>登记纸样 / 唛架实际准备范围</summary><fieldset disabled={busy}><legend>登记实际准备范围</legend><label>成果<select value={kind} onChange={e=>{const next=e.target.value as typeof kind;void (async()=>{if(dirty&&!await confirmInApp('切换成果会放弃本次未保存说明，确认切换？'))return;setKind(next);setNote('');setPending([]);setWhole(false);setTouched(false);})();}}><option>纸样完成</option><option>唛架完成</option></select></label>
 <p>普通单及急单均可先做不受欠辅料影响的部分。原48小时从本版正式制单发布计时，后到物料不重置。</p>
 <div>{sheet.cutting.lines.map(l=><label className="preparation-range-choice" key={l.lineId}><input type="checkbox" checked={selected.includes(l.lineId)} onChange={e=>{setTouched(true);setSelected(ids=>e.target.checked?[...ids,l.lineId]:ids.filter(id=>id!==l.lineId));}}/>{l.poNumber??'待补PO'} · {l.color}</label>)}</div>
 <label className="preparation-range-choice"><input type="checkbox" checked={whole} onChange={e=>{setTouched(true);setWhole(e.target.checked);}}/>本项全部适用款色均已完成，且不再欠本项物料</label>
 {!whole&&sheet.materials?.items.length? <fieldset><legend>仍需补料后复核 / 补做</legend>{sheet.materials.items.map(m=><label className="preparation-range-choice" key={m.id}><input type="checkbox" checked={pending.includes(m.id)} onChange={e=>{setTouched(true);setPending(ids=>e.target.checked?[...ids,m.id]:ids.filter(id=>id!==m.id));}}/>{m.name} · {m.specification}</label>)}</fieldset>:null}
 <label>本次已做范围及待补做说明<textarea value={note} maxLength={1000} onChange={e=>{setTouched(true);setNote(e.target.value);}}/></label>
 <Button disabled={!note.trim()||!selected.length||sheet.facts.some(f=>f.kind===kind)} onClick={()=>void save('/complete',{preparationId:sheet.preparationId,kind,expectedReadinessRevision:readiness.revision,range:{expectedVersion:prior?.version??0,lineIds:selected,complete:whole,pendingMaterialIds:whole?[]:pending,note,evidenceIds:[]}})}>{whole?`确认整单${kind}`:'保存局部准备，不放行整单'}</Button>
 {readiness.ranges.some(r=>r.preparationId!==sheet.preparationId)&&<details><summary>前版准备范围（供本轮复核，不自动完成本轮）</summary>{readiness.ranges.filter(r=>r.preparationId!==sheet.preparationId).map(r=><p key={r.rangeId}>{r.kind} · {r.note}</p>)}</details>}
 {readiness.ranges.filter(r=>r.preparationId===sheet.preparationId).map(r=><p key={r.rangeId}>{r.kind} · 第{r.version}次 · {r.complete?'全部适用范围已完成':'局部准备，尚未完成整单'} · {r.note}</p>)}</fieldset></details>;
}
