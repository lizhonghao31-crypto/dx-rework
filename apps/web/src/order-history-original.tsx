import {useCallback} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {DigitalIdSchema} from '@dx-rework/contracts/digital-production';
import {z} from 'zod';
import {DesignerOriginalShell} from './designer-original-shell.js';
import {digitalRequest} from './digital-production-api.js';
import {useForegroundRead} from './use-foreground-read.js';
import {useForegroundWait} from './foreground-loading.js';

const eventLabels={bulk_fabric_report:'原验布报告',bulk_fabric_decision:'原质量处理决定',bulk_materials_dispatched:'原辅料发出记录',
 garment_receipt_qc:'原到仓成衣检查',garment_receipt_qc_time_verified:'原到仓检查时间核实'} as const;
const eventKind=z.enum(['bulk_fabric_report','bulk_fabric_decision','bulk_materials_dispatched','garment_receipt_qc','garment_receipt_qc_time_verified']);
const historySchema=z.object({orderId:DigitalIdSchema,family:z.enum(['fabric','receipt_quality']),items:z.array(z.object({
 eventId:DigitalIdSchema,kind:eventKind,occurredAt:z.string().nullable(),recordedAt:z.string(),operatorName:z.string().nullable(),
 payload:z.object({material:z.string().nullish(),result:z.string().nullish(),allowUse:z.boolean().optional(),qualifiedQuantity:z.number().optional(),
  problem:z.string().nullish(),reason:z.string().nullish(),note:z.string().nullish(),quantity:z.number().optional(),defectiveQuantity:z.number().optional(),
  items:z.array(z.object({materialId:DigitalIdSchema,name:z.string(),quantity:z.number(),unit:z.string()})).optional()}),
})).length(1)});
const time=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未登记';

export function OrderHistoryOriginal({orderId,domain,onClose}:{orderId:string;domain:'bulk-preparation'|'closure';onClose():void}){
 const query=new URLSearchParams(location.search),selected=DigitalIdSchema.safeParse(query.get('originalEvent'));
 const eventId=selected.success&&query.getAll('originalEvent').length===1?selected.data:null;
 const load=useCallback(async(signal:AbortSignal)=>{
  const detail=historySchema.parse(await digitalRequest(`orders/${orderId}/${domain}/history?${new URLSearchParams({eventId:eventId!})}`,'GET',undefined,undefined,{signal}));
  const original=detail.items[0]!;
  if(detail.orderId!==orderId||detail.family!==(domain==='closure'?'receipt_quality':'fabric')||original.eventId!==eventId||
     original.kind==='bulk_materials_dispatched'&&(domain!=='bulk-preparation'||!original.payload.items))
   throw Error('历史记录与当前原单不一致。');
  return original;
 },[orderId,domain,eventId]);
 const reader=useForegroundRead(orderId,eventId,load);
 useForegroundWait(reader.foregroundKey);
 const original=reader.value;
 const values=original?[['原材料',original.payload.material],['原检查结论',original.payload.result],
  ['当次质量决定',original.payload.allowUse===undefined?null:original.payload.allowUse?'允许使用':'继续处理'],
  ['当次检查数量',original.payload.quantity],['当次合格数量',original.payload.qualifiedQuantity],['当次次品数量',original.payload.defectiveQuantity],
  ['原问题',original.payload.problem],['原说明',original.payload.note],['原处置原因',original.payload.reason]]:[];
 return <DesignerOriginalShell title={original?`${eventLabels[original.kind]} · 只读`:'原检查历史'} onClose={onClose}>
  {!eventId?<p role="alert">原记录编号无效，请返回原单选择。</p>:
   reader.error?<p role="alert">{reader.error.message}<Button label="重新读取原记录" size="sm" onClick={reader.retry}/></p>:
   original?<dl>
    <div><dt>当次发生时间</dt><dd>{time(original.occurredAt)}</dd></div>
    <div><dt>登记时间及人员</dt><dd>{time(original.recordedAt)} · {original.operatorName??'未登记'}</dd></div>
    {values.filter(([,value])=>value!==null&&value!==undefined&&value!=='').map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    {original.kind==='bulk_materials_dispatched'&&original.payload.items?.map(item=><div key={item.materialId}><dt>{item.name}</dt><dd>{item.quantity} {item.unit}</dd></div>)}
   </dl>:<p role="status">正在读取所选原记录…</p>}
 </DesignerOriginalShell>;
}
