import {useCallback} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Link} from '@astryxdesign/core/Link';
import {DigitalIdSchema} from '@dx-rework/contracts/digital-production';
import {preparationInvestmentRowKey,preparationMaterialLabels,type PreparationResource,type ProductionReadinessState} from '@dx-rework/contracts/production-readiness';
import {createWebUrls} from '../url-contract.js';
import {DesignerOriginalShell} from './designer-original-shell.js';
import {digitalRequest} from './digital-production-api.js';
import {useForegroundWait} from './foreground-loading.js';
import {useForegroundRead} from './use-foreground-read.js';

const urls=createWebUrls(import.meta.env.BASE_URL);
const stateLabels={ready:'已登记备齐',partial:'部分到位',unknown:'尚未核实',withdrawn:'已撤回'};
const time=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未登记';

export function PreparationMaterialOriginal({resource,onClose}:{resource:PreparationResource;onClose():void}){
 const {kind,id}=resource,query=new URLSearchParams(location.search);
 const recordId=DigitalIdSchema.safeParse(query.get('originalMaterial'));
 const rawVersion=query.get('originalMaterialVersion')??'',version=Number(rawVersion);
 const target=recordId.success&&/^[1-9]\d*$/.test(rawVersion)&&Number.isSafeInteger(version)&&
  query.getAll('originalMaterial').length===1&&query.getAll('originalMaterialVersion').length===1?recordId.data:null;
 const base=`${kind==='source'?'sources':'orders'}/${id}/production-readiness`;
 const load=useCallback(async(signal:AbortSignal)=>{
  const sheet=await digitalRequest<ProductionReadinessState>(base,'GET',undefined,undefined,{signal});
  if(sheet.resource.kind!==kind||sheet.resource.id!==id||!Array.isArray(sheet.history))throw Error('物料资料与当前原单不一致。');
  return sheet;
 },[base,kind,id]);
 const reader=useForegroundRead(base,target?`${target}:${version}`:null,load);
 useForegroundWait(reader.foregroundKey);
 const matches=reader.value?.history.filter(record=>record.recordId===target&&record.version===version);
 const record=matches?.length===1?matches[0]:undefined;
 return <DesignerOriginalShell onClose={onClose} title={record?`${preparationMaterialLabels[record.kind]} · 第 ${version} 版 · 只读`:'原物料记录'}>
  {!target||reader.value&&!record?<p role="alert">找不到所选物料原记录或版本，请返回原单核对。</p>:
   reader.error?<p role="alert">{reader.error.message}<Button label="重新读取物料原件" size="sm" onClick={reader.retry}/></p>:
   record?<>
    <dl>
     <div><dt>当次记录</dt><dd>{stateLabels[record.state]}</dd></div>
     <div><dt>发生时间</dt><dd>{time(record.occurredAt)}</dd></div>
     <div><dt>登记时间及人员</dt><dd>{time(record.recordedAt)} · {record.operatorName}</dd></div>
     {record.sourceDocumentVersion&&<div><dt>采用开发资料</dt><dd>第 {record.sourceDocumentVersion} 版</dd></div>}
     {record.orderInstructionVersion&&<div><dt>采用正式制单</dt><dd>第 {record.orderInstructionVersion} 版</dd></div>}
     <div><dt>登记说明</dt><dd>{record.note}</dd></div>
    </dl>
    {record.quantities.length>0&&<ul>{record.quantities.map(row=>{
     const occurrence=record.investmentQuantityOccurrences?.[preparationInvestmentRowKey(row)];
     return <li key={preparationInvestmentRowKey(row)}>{row.name} · {row.quantity} {row.unit}{occurrence&&` · ${time(occurrence.occurredAt)}`}</li>;
    })}</ul>}
    {record.handoverMaterials?.length?<ul>{record.handoverMaterials.map((row,index)=><li key={row.materialId??index}>
     {[row.category,row.name,row.specification,row.color,row.quantity,row.supplier].filter(Boolean).join(' · ')}
    </li>)}</ul>:null}
    {!record.valid&&record.invalidReasons.length>0&&<p>当前有效性：{record.invalidReasons.join('；')}</p>}
    {record.evidenceIds.map((attachmentId,index)=><p key={attachmentId}><Link
     href={urls.apiUrl(`digital-production/${base}/attachments/${attachmentId}`)} target="_blank" rel="noreferrer">原凭证 {index+1}</Link></p>)}
   </>:<p role="status">正在读取所选物料原件…</p>}
 </DesignerOriginalShell>;
}
