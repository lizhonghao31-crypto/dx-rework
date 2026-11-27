import {useRef,useState} from 'react';
import {DEVELOPMENT_AUXILIARY_QUANTITY_UNITS,SaveDevelopmentDesignerCorrectionSchema,developmentCreationBasicsIssues,
 developmentPreparationQuantityIssues,isDevelopmentMaterialPlaceholder,type DevelopmentDocument,type DevelopmentSheet} from '@dx-rework/contracts/digital-development';
import {Selector} from '@astryxdesign/core/Selector';
import {createClientRequestId} from './client-request-id.js';
import {DevelopmentEntryAction,DevelopmentEntryText} from './development-entry-controls.js';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {confirmInApp} from './system-dialog.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';

/** A narrowly scoped amendment of the latest source, not a new draft or customer order. */
export function DevelopmentDesignerCorrection({sourceId,round,version,document,notes,disabled,mode='convert',onRead,onPending,onCancel}:{
 sourceId:string;round:number;version:number;document:DevelopmentDocument;disabled:boolean;
 notes?:{brand:string;referenceNote:string}|undefined;mode?:'convert'|'edit';
 onRead:(sheet:DevelopmentSheet)=>void;onPending:(active:boolean)=>void;onCancel?:()=>void;
}){
 const original={styleName:document.workbenchSheet?.styleName??'',brand:notes?.brand??document.workbenchSheet?.brand??'',referenceNote:notes?.referenceNote??document.workbenchSheet?.referenceNote??''};
 const [basics,setBasics]=useState(original);
 const [reason,setReason]=useState('');
 const [materials,setMaterials]=useState<Record<string,{quantity?:string;quantityUnit?:string}>>({});
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[received,setReceived]=useState<number|null>(null),[uncertain,setUncertain]=useState(false);
 const attempt=useRef<{payload:string;key:string}|null>(null),writing=useRef(false);
 const dirty=basics.styleName!==original.styleName||basics.brand!==original.brand||basics.referenceNote!==original.referenceNote||Boolean(reason.trim())||Object.keys(materials).length>0;
 useDigitalDetailNavigationGuard(dirty||uncertain||received!==null,busy,writing,'原资料订正尚未保存或确认，仍要离开吗？');
 const quantityIssues=developmentPreparationQuantityIssues(document,true);
 const missing=developmentCreationBasicsIssues(document).length>0||quantityIssues.length>0;
 const route=`sources/${sourceId}/development`;
 const install=async(expected:number)=>{
  const sheet=await digitalRequest<DevelopmentSheet>(route+'?round='+round);
  if(sheet.sourceId!==sourceId||sheet.roundNumber!==round||sheet.version<expected||!sheet.document)throw new Error('资料已保存，当前版本仍需重新读取并核对');
  onRead(sheet);onPending(false);setReason('');setMaterials({});setReceived(null);
 };
 const save=async()=>{
  if(writing.current||disabled)return;
  setError('');writing.current=true;setBusy(true);onPending(true);
  try{
   if(received!==null){await install(received);return;}
   const parsed=SaveDevelopmentDesignerCorrectionSchema.safeParse({roundNumber:round,expectedDocumentVersion:version,reason,
    ...(basics.styleName!==original.styleName?{styleName:basics.styleName}:{}),...(basics.brand!==original.brand?{brand:basics.brand}:{}),
    ...(basics.referenceNote!==original.referenceNote?{referenceNote:basics.referenceNote}:{}),
    materialQuantities:Object.entries(materials).map(([materialId,patch])=>{
     const original=document.materials.find(item=>item.materialId===materialId);
     return {materialId,...(original&&original.category!=='辅料'&&!original.quantityUnit?{quantityUnit:'米'}:{}),...patch};
    })});
   if(!parsed.success)throw new Error(parsed.error.issues[0]?.message??'请检查订正内容');
   const payload=JSON.stringify(parsed.data);
   if(uncertain&&attempt.current?.payload!==payload)throw new Error('原提交结果待核对，不能改内容重新提交');
   if(attempt.current?.payload!==payload)attempt.current={payload,key:createClientRequestId()};
   const answer=await digitalRequest<{sourceId:string;roundNumber:number;version:number}>(route+'/designer-correction','PUT',parsed.data,attempt.current.key);
   if(answer.sourceId!==sourceId||answer.roundNumber!==round||!Number.isSafeInteger(answer.version)||answer.version<=version)
    throw new DigitalRequestError('原写入回执不完整，请使用原请求核对',200,'INVALID_RESPONSE');
   setUncertain(false);setReceived(answer.version);attempt.current=null;
   try{await install(answer.version);}catch{setError('资料已保存，当前资料读取失败。请重新读取已保存版本。');}
  }catch(reason){
   const unknown=reason instanceof DigitalRequestError&&reason.resultUnknown;
   if(unknown)setUncertain(true);else if(!uncertain&&received===null)onPending(false);
   setError(reason instanceof Error?reason.message:'资料订正未确认，请核对原版本');
  }finally{writing.current=false;setBusy(false);}
 };
 if(mode==='convert'&&!missing&&received===null&&!uncertain)return null;
 const editingDisabled=busy||disabled||received!==null||uncertain;
 return <fieldset className="development-create-card" aria-label={mode==='convert'?'转正前补齐原开发资料':'编辑开发单'}>
  <legend>{mode==='convert'?`转正前补齐原开发资料 · v${version}`:`第 ${round} 轮 · v${version} · 编辑中`}</legend>
  <p>{mode==='convert'?'保存为本轮新版本。原发布版、制作数量和实际投料批次不改写。':'这里只订正品名、品牌与参考资料。制作规格、工艺或数量有实质改变，请从原复版入口办理。'}</p>
  <div className="development-basic-grid">
   <DevelopmentEntryText label="款式（品名）" visibleLabel isRequired isDisabled={editingDisabled} value={basics.styleName}
    onChange={styleName=>setBasics(previous=>({...previous,styleName}))}/>
   <DevelopmentEntryText label="品牌" visibleLabel isRequired isDisabled={editingDisabled} value={basics.brand}
    onChange={brand=>setBasics(previous=>({...previous,brand}))}/>
   {mode==='edit'&&<DevelopmentEntryText label="参考款 / 版型说明" visibleLabel isDisabled={editingDisabled} value={basics.referenceNote}
    onChange={referenceNote=>setBasics(previous=>({...previous,referenceNote}))}/>}
  </div>
  {mode==='convert'&&document.materials.filter(row=>!isDevelopmentMaterialPlaceholder(row)&&quantityIssues.some(issue=>issue.materialId===row.materialId)).map(row=>
   <div className="development-basic-grid" key={row.materialId}>
    <strong>{row.name||row.label||row.category}</strong>
    {!row.quantity.trim()?<DevelopmentEntryText label={`${row.name||row.category} 备料数量`} visibleLabel isRequired isDisabled={editingDisabled}
      value={materials[row.materialId]?.quantity??''} onChange={quantity=>setMaterials(current=>({...current,[row.materialId]:{...current[row.materialId],quantity}}))}/>:
     <output>{row.quantity}</output>}
    {row.category!=='辅料'?<output>米</output>:row.quantityUnit?<output>{row.quantityUnit}</output>:
     <Selector label={`${row.name||row.category} 数量单位`} size="sm" isRequired isDisabled={editingDisabled} placeholder="请选择"
      value={materials[row.materialId]?.quantityUnit??''} options={[...DEVELOPMENT_AUXILIARY_QUANTITY_UNITS]}
      onChange={quantityUnit=>setMaterials(current=>({...current,[row.materialId]:{...current[row.materialId],quantityUnit}}))}/>}
    {row.quantityUnit&&quantityIssues.some(issue=>issue.materialId===row.materialId&&issue.field==='quantityUnit')&&
     <small>已登记的原计量须从原投料更正入口核对，此处不会替换旧单位。</small>}
   </div>)}
  <DevelopmentEntryText label="本次订正理由" visibleLabel isRequired isDisabled={editingDisabled} value={reason} onChange={setReason} maxLength={1000}/>
  {error&&<p role="alert">{error}</p>}
  {mode==='edit'&&onCancel&&<DevelopmentEntryAction type="button" disabled={editingDisabled} onClick={async()=>{
   if(!dirty||await confirmInApp('尚未保存本次订正，确定取消编辑？'))onCancel();
  }}>取消编辑</DevelopmentEntryAction>}
  <DevelopmentEntryAction type="button" variant="secondary" disabled={disabled||busy} onClick={()=>void save()}>
   {received!==null?'重新读取已保存版本':uncertain?'用同一原请求核对结果':mode==='edit'?'保存修改':'保存本轮资料订正'}
  </DevelopmentEntryAction>
 </fieldset>;
}
