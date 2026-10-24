import {Button} from '@dx-rework/ui';
import type {BulkPreparationSheet} from '@dx-rework/contracts/bulk-preparation';
export function BulkMaterialsPanel({sheet,busy,readonly,save}:{sheet:BulkPreparationSheet;busy:boolean;readonly:boolean;save:(path:string,input:unknown)=>Promise<void>}){
 const m=sheet.materials;if(!m||!m.items.length&&!m.history.length)return null;
 return <details className="bulk-fabric-panel"><summary>辅料发出记录 · {m.history.length} 次</summary><p>当前加工厂：{m.supplierName??'待批准'}。发出不代表工厂已收到。</p>
 {m.canDispatch&&!readonly&&<form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void save('/materials-dispatch',{instructionVersion:m.instructionVersion,supplierId:m.supplierId,occurredAt:new Date(`${String(f.get('at'))}+08:00`).toISOString(),note:String(f.get('note')??''),items:m.items.filter(i=>Number(f.get(i.id))>0).map(i=>({materialId:i.id,quantity:Number(f.get(i.id)),unit:String(f.get(`unit:${i.id}`)??'')}))});}}><fieldset disabled={busy}><legend>本次实际发出</legend>{m.items.map(i=><div key={i.id} className="bulk-fabric-fields"><label>{i.name} · {i.materialColor} · {i.specification}<input type="number" name={i.id} min="0" step="any" defaultValue="0"/></label><label>单位<input name={`unit:${i.id}`} maxLength={20}/></label></div>)}<label>实际时间（北京时间）<input name="at" type="datetime-local" required/></label><label>说明<textarea name="note" maxLength={1000} rows={2}/></label><Button type="submit">保存辅料发出</Button></fieldset></form>}
 {m.history.map(h=><p key={h.eventId}>{new Date(h.occurredAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} · {h.operatorName} · {h.items.map(i=>`${i.name} ${i.quantity}${i.unit}`).join('；')} {h.note}</p>)}
 </details>;
}
