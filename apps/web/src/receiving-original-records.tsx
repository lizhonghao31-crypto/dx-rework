import {useCallback} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Link} from '@astryxdesign/core/Link';
import {DigitalIdSchema} from '@dx-rework/contracts/digital-production';
import {PackingActualTimeSchema} from '@dx-rework/contracts';
import {z} from 'zod';
import {useForegroundRead} from './use-foreground-read.js';
import {useForegroundWait} from './foreground-loading.js';
import {digitalChildDetailHref} from './digital-detail-route.js';
import {digitalRequest} from './digital-production-api.js';
import {createWebUrls} from '../url-contract.js';
import {DesignerOriginalShell} from './designer-original-shell.js';

const kinds=z.enum(['receipt','correction','packing','resolution']);
const quantity=z.union([z.number().int().nonnegative(),z.string().regex(/^\d+$/)]);
const amounts={documentQuantity:quantity,actualQuantity:quantity,defectiveQuantity:quantity};
const registration={id:DigitalIdSchema,at:z.string(),by:z.string().nullable()};
const historySchema=z.object({orderId:DigitalIdSchema,history:z.object({
 receipts:z.array(z.object({receiptId:DigitalIdSchema,batchId:DigitalIdSchema,receivedAt:z.string().nullable(),receivedDate:z.string().nullable().optional(),receivedBy:z.string().nullable(),...amounts})),
 corrections:z.array(z.object({...registration,...amounts})),
 packing:z.array(z.object({...registration,quantity,actualTime:PackingActualTimeSchema})),
 resolutions:z.array(z.object({...registration,differenceType:z.enum(['receiving','packing']),result:z.string()})),
}).nullable(),documents:z.array(z.object({id:DigitalIdSchema,filename:z.string(),entityId:DigitalIdSchema}))});
type Kind=z.infer<typeof kinds>;
type OriginalFact={id:string;kind:Kind;label:string;at:string|null;dateOnly?:boolean;recordedAt?:string;by:string|null;facts:readonly (readonly [string,string])[]};
type OriginalFile=z.infer<typeof historySchema>['documents'][number];
const quantities=(row:z.infer<z.ZodObject<typeof amounts>>)=>[
 ['原送货单',`${row.documentQuantity} 件`],['实收',`${row.actualQuantity} 件`],['次品',`${row.defectiveQuantity} 件`],
] as const;

async function readRecords(orderId:string,signal:AbortSignal) {
 const response=historySchema.parse(await digitalRequest(`orders/${orderId}/receipt-summary?documentBindings=true`,'GET',undefined,undefined,{signal}));
 if(response.orderId!==orderId)throw Error('收货历史不属于当前订单。');
 const history=response.history;
 const records:OriginalFact[]=!history?[]:[
  ...history.receipts.map(row=>({id:row.receiptId,kind:'receipt' as const,label:'原收货',at:row.receivedDate??row.receivedAt,dateOnly:Boolean(row.receivedDate),by:row.receivedBy,facts:quantities(row)})),
  ...history.corrections.map(row=>({id:row.id,kind:'correction' as const,label:'收货更正',at:row.at,by:row.by,facts:quantities(row)})),
  ...history.packing.map(row=>({id:row.id,kind:'packing' as const,label:'装箱记录',
   at:row.actualTime.precision==='instant'?row.actualTime.at:row.actualTime.precision==='date'?row.actualTime.date:null,
   dateOnly:row.actualTime.precision==='date',recordedAt:row.at,by:row.by,facts:[['装箱数量',`${row.quantity} 件`]] as const})),
  ...history.resolutions.map(row=>({id:row.id,kind:'resolution' as const,label:`${row.differenceType==='packing'?'装箱':'收货'}差异处理`,at:row.at,by:row.by,facts:[['原处理结果',row.result]] as const})),
 ];
 const receiptBatches=new Set(history?.receipts.map(row=>row.batchId)??[]);
 return {records,documents:response.documents,batchFiles:response.documents.filter(file=>receiptBatches.has(file.entityId))};
}

export function readReceivingOriginalSearch(search:string){
 const query=new URLSearchParams(search);
 if(!query.has('originalReceiving')&&!query.has('originalReceivingId'))return undefined;
 const kind=kinds.safeParse(query.get('originalReceiving')),id=DigitalIdSchema.safeParse(query.get('originalReceivingId'));
 return query.getAll('originalReceiving').length===1&&query.getAll('originalReceivingId').length===1&&kind.success&&id.success
  ?{kind:kind.data,id:id.data}:null;
}

const instantText=(at:string)=>new Date(at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
const dateText=(record:OriginalFact)=>record.at?(record.dateOnly?`${record.at}（仅日期）`:instantText(record.at)):'实际时间未登记';
const urls=createWebUrls(import.meta.env.BASE_URL);
function OriginalFiles({files,label}:{files:OriginalFile[];label:string}){
 return files.length>0?<details><summary>{label}</summary><ul>{files.map(file=><li key={file.id}>
  <Link href={urls.apiUrl(`tools/attachments/${file.id}/download?mode=preview`)} target="_blank" rel="noreferrer">{file.filename}</Link>
 </li>)}</ul></details>:null;
}

export function ReceivingOriginalDirectory({orderId,category,returnTo}:{orderId:string;category:'receiving'|'packing';returnTo:string}){
 const load=useCallback((signal:AbortSignal)=>readRecords(orderId,signal),[orderId]);
 const read=useForegroundRead(orderId,orderId,load);
 useForegroundWait(read.foregroundKey);
 if(read.error)return <p role="alert">{read.error.message}<Button label="重新读取收货原单" size="sm" onClick={read.retry}/></p>;
 if(!read.value)return <p role="status">正在读取收货原单…</p>;
 const visible=read.value.records.filter(item=>category==='packing'?item.kind==='packing'||item.kind==='resolution':item.kind==='receipt'||item.kind==='correction');
 if(!visible.length)return <p>暂无相关收货原记录。</p>;
 return <><ul>{visible.map(item=>{
  const href=digitalChildDetailHref('/ui/digital-production?'+new URLSearchParams({closure:orderId,originalReceiving:item.kind,originalReceivingId:item.id}),returnTo,import.meta.env.BASE_URL);
  return <li key={`${item.kind}:${item.id}`}><Link href={href}>{item.label} · {dateText(item)}</Link>{item.by&&<> · {item.by}</>}</li>;
 })}</ul>{category==='receiving'&&<OriginalFiles label="原收货批次凭证" files={read.value.batchFiles}/>}</>;
}

export function ReceivingOriginalRecord({orderId,target,onClose}:{orderId:string;target:Exclude<ReturnType<typeof readReceivingOriginalSearch>,undefined>;onClose():void}){
 const load=useCallback((signal:AbortSignal)=>readRecords(orderId,signal),[orderId]);
 const read=useForegroundRead(orderId,target?`${target.kind}:${target.id}`:null,load);
 useForegroundWait(read.foregroundKey);
 const record=target&&read.value?.records.find(item=>item.id===target.id&&item.kind===target.kind);
 return <DesignerOriginalShell onClose={onClose} title={`${record?.label??'收货原记录'} · 只读`}>
  {!target||read.value&&!record?<p role="alert">找不到选中的本单记录，请返回原单核对。</p>:read.error?
   <p role="alert">{read.error.message}<Button label="重新读取收货原单" size="sm" onClick={read.retry}/></p>:record?
   <><p>{dateText(record)}{record.by&&<> · {record.by}</>}</p>
    {record.recordedAt&&<p>登记时间 · {instantText(record.recordedAt)}</p>}
    <dl>{record.facts.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {record.kind==='resolution'&&<OriginalFiles label="本次差异处理凭证" files={read.value!.documents.filter(file=>file.entityId===record.id)}/>}
   </>
   :<p role="status">正在读取所选收货原单…</p>}
 </DesignerOriginalShell>;
}
