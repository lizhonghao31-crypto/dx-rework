import {useCallback,useEffect,useRef,useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Selector} from '@astryxdesign/core/Selector';
import {Table,type TableColumn} from '@astryxdesign/core/Table';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Surface} from '@dx-rework/ui';
import {formatBusinessDecimal} from '@dx-rework/contracts/business-display';
import {QuotationResourceSchema,type QuotationResource} from '@dx-rework/contracts/digital-quotation';
import {
 SecondaryCraftDecisionSchema,SecondaryCraftDetailSchema,SecondaryCraftDraftSchema,SecondaryCraftListSchema,
 SecondaryCraftReceiptSchema,SecondaryCraftSubmissionSchema,SecondaryCraftSuppliersSchema,type SecondaryCraftDetail,type SecondaryCraftList,
} from '@dx-rework/contracts/secondary-craft-quotation';
import {createWebUrls} from '../url-contract.js';
import {createClientRequestId} from './client-request-id.js';
import {designerAstryxCss} from './designer-astryx.js';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {DocumentTableScroll} from './document-editor.js';
import {OrderRushBadge} from './order-rush-badge.js';
import {QuotationBasisImage} from './quotation-basis-image.js';
import './quotation-basis.css';
import {useForegroundWait} from './foreground-loading.js';
import {unknownWriteResult} from './request-response-feedback.js';
import {SUBMISSION_RECOVERY_WINDOW_MS} from './submission-attempt.js';
import {useForegroundRead} from './use-foreground-read.js';
import {ListPagination} from './list-pagination.js';
import {useDebouncedValue} from './use-debounced-value.js';
import {craftDirectoryRowKey,pageAuthorizedCraftDirectory,readCraftDirectoryView,writeCraftDirectoryView,type CraftDirectoryView} from './secondary-craft-directory-view.js';

const urls=createWebUrls(import.meta.env.BASE_URL);
const labels={pending:'待填写',draft:'草稿',submitted:'待审批',approved:'已批准',returned:'已退回'};
const stageLabel={development:'开发',bulk:'大货'};
const modes=[{value:'in_house',label:'内做'},{value:'outsourced',label:'外发'}];
const pathFor=(row:QuotationResource)=>`${row.kind==='order'?'orders':'sources'}/${row.id}/quotation`;
export const secondaryCraftHref=(row?:QuotationResource,rowId?:string,browse?:CraftDirectoryView)=>{
 const params=browse?writeCraftDirectoryView(browse):new URLSearchParams();
 if(row&&rowId){params.set('kind',row.kind);params.set('id',row.id);params.set('craft',rowId);}
 return urls.pageUrl(`ui/secondary-craft-quotation${params.size?'?'+params:''}`);
};
const list=(signal:AbortSignal)=>digitalRequest('secondary-craft-quotations','GET',undefined,undefined,{signal}).then(SecondaryCraftListSchema.parse);

export function SecondaryCraftQuotationPage(){
 const search=new URLSearchParams(location.search),rowId=search.get('craft');
 const resource=QuotationResourceSchema.safeParse({kind:search.get('kind'),id:search.get('id')});
 const version=search.get('version')??'';
 const browse=readCraftDirectoryView(search);
 return <div className="dx-designer-astryx" lang="zh-CN">
  <style>{designerAstryxCss}</style>
  {rowId?(resource.success&&/^[0-9a-f-]{36}$/i.test(rowId)&&(!version||/^[1-9]\d*$/.test(version))
   ?<CraftDetail resource={resource.data} rowId={rowId} version={version} browse={browse}/>
   :<Surface><p role="alert">工艺编号无效，请从原报价进入。</p></Surface>):<CraftDirectory initial={browse}/>}
 </div>;
}

function CraftDirectory({initial}:{initial:CraftDirectoryView}){
 const read=useForegroundRead('secondary-craft-directory','mine',list);
 useForegroundWait(read.foregroundKey);
 const items=read.value?.items??[];
 const [view,setView]=useState(initial),[searchInput,setSearchInput]=useState(initial.search),search=useDebouncedValue(view.search,250),composing=useRef(false),focus=useRef(initial.focus);
 const change=(patch:Partial<CraftDirectoryView>)=>setView(current=>{const next={...current,...patch};delete next.focus;return next;});
 const current=searchInput===view.search&&view.search===search&&!read.waiting&&!read.error;
 const page=pageAuthorizedCraftDirectory(items,{...view,search});
 const craftOptions=[...new Set(items.map(item=>item.label))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
 const focusId=(value:string)=>`secondary-craft-directory-${value}`;
 const ready=Boolean(read.value?.ready);
 useEffect(()=>{
  const id=focus.current;if(!id||!ready)return;
  const frame=requestAnimationFrame(()=>{focus.current=undefined;
   if(document.activeElement!==document.body)return;
   const target=document.getElementById(focusId(id));
   (target??document.querySelector<HTMLInputElement>('#secondary-craft-directory-search'))?.focus({preventScroll:true});
   target?.scrollIntoView({block:'nearest'});
  });
  return ()=>cancelAnimationFrame(frame);
 },[ready]);
 useEffect(()=>{if(current&&ready)history.replaceState(history.state,'',secondaryCraftHref(undefined,undefined,{...view,page:page.page}));},[current,ready,view,page.page]);
 const columns:TableColumn<SecondaryCraftList['items'][number]>[]=[
  {key:'styleNo',header:'款号 / 工艺',renderCell:item=>{const id=craftDirectoryRowKey(item);return <><a id={focusId(id)} href={secondaryCraftHref(item.resource,item.rowId,{...view,search,page:page.page,focus:id})}>{item.styleNo} · {item.label}</a><OrderRushBadge value={item.orderRush}/></>;}},
  {key:'customerCode',header:'客户',renderCell:item=>item.customerCode??'—'},
  {key:'stage',header:'阶段与资料',renderCell:item=>`${stageLabel[item.stage]} · 第 ${item.round} 轮 · 资料 v${item.sourceVersion}`},
  {key:'authorName',header:'报价人',renderCell:item=>item.authorName??'—'},
  {key:'supplier',header:'加工厂',renderCell:item=>item.savedPricing?.mode==='in_house'?'本厂':item.supplier?.name??'—'},
  {key:'savedPricing',header:'价格 / 单位',renderCell:item=>item.savedPricing?.amount&&item.savedPricing.unit?<span title={`${item.savedPricing.amount} 元 / ${item.savedPricing.unit}`}>{formatBusinessDecimal(item.savedPricing.amount,1)} 元 / {item.savedPricing.unit}</span>:'—'},
  {key:'state',header:'状态',renderCell:item=>`${labels[item.state]}${item.note?` · ${item.note}`:''}`},
 ];
 return <Surface><h1>二次工艺报价与选厂</h1>
  <div className="budget-heading" aria-label="二次工艺目录筛选">
   <TextInput id="secondary-craft-directory-search" label="搜索订单 ID、PO、客户或工艺" value={searchInput} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={event=>{composing.current=false;const next=(event.target instanceof HTMLInputElement?event.target.value:searchInput).slice(0,100);setSearchInput(next);change({search:next,page:1});}} onChange={value=>{const next=value.slice(0,100);setSearchInput(next);if(!composing.current)change({search:next,page:1});}}/>
   <Selector label="报价 / 审批状态" value={view.state} options={[{value:'all',label:'全部状态'},...Object.entries(labels).map(([value,label])=>({value,label}))]} onChange={value=>{if(value==='all'||Object.hasOwn(labels,value))change({state:value as CraftDirectoryView['state'],page:1});}}/>
   <Selector label="工艺项目" value={view.craft} options={[{value:'',label:'全部工艺'},...craftOptions.map(value=>({value,label:value}))]} onChange={craft=>change({craft,page:1})}/>
  </div>
  {read.error&&<p role="alert">{read.error.message} <Button label="重试读取" onClick={read.retry}/></p>}
  {read.value?.ready===false&&<p>联合报价流程尚未就绪。</p>}
  {read.value?.ready&&items.length===0&&<p>暂无分配给您的工艺报价或待审批工艺。</p>}
  {ready&&current&&items.length>0&&!page.total&&<p>没有符合条件的工艺报价。</p>}
  {page.items.length>0&&<DocumentTableScroll scrollLabel="二次工艺报价目录"><Table columns={columns} data={page.items} idKey={craftDirectoryRowKey} aria-label="二次工艺报价目录" density="compact"/></DocumentTableScroll>}
  {ready&&<ListPagination page={page.page} totalPages={current?page.totalPages:null} total={current?page.total:null} busy={!current} ariaLabel="二次工艺报价分页" onPageChange={target=>change({page:target})}/>}
 </Surface>;
}

function CraftDetail({resource,rowId,version,browse}:{resource:QuotationResource;rowId:string;version:string;browse:CraftDirectoryView}){
 const path=`${pathFor(resource)}/secondary-craft/${rowId}`;
 const query=version?`?version=${version}`:'';
 const load=useCallback(async(signal:AbortSignal)=>{
  const detail=SecondaryCraftDetailSchema.parse(await digitalRequest(path+query,'GET',undefined,undefined,{signal}));
  if(detail.target.rowId!==rowId||version&&detail.version!==Number(version))throw Error('未读取到请求的工艺版本。');
  return detail;
 },[path,query,rowId,version]);
 const read=useForegroundRead('secondary-craft-detail',path+query,load);
 useForegroundWait(read.foregroundKey);
 return <Surface><a href={secondaryCraftHref(undefined,undefined,browse)}>返回二次工艺报价列表</a>
  {read.error&&<p role="alert">{read.error.message} <Button label="重试读取" onClick={read.retry}/></p>}
  {read.value&&<CraftForm key={path+query} original={read.value} path={path} href={secondaryCraftHref(resource,rowId,browse)} version={version}/>}
 </Surface>;
}

type Attempt={action:'draft'|'submit'|'decision';body:unknown;expected:number;key:string;startedAt:number};
function CraftForm({original,path,href,version}:{original:SecondaryCraftDetail;path:string;href:string;version:string}){
 const [item,setItem]=useState(original),[edited,setEdited]=useState<SecondaryCraftDetail['draft']>(null);
 const [reason,setReason]=useState(''),[search,setSearch]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [uncertain,setUncertain]=useState<Attempt|null>(null),writing=useRef(false);
 const current=edited??item.draft??{mode:'in_house',supplierId:null,unit:item.target.pricingUnit,unitPrice:'',applicableQuantity:null,note:'',attachmentIds:item.target.attachmentIds};
 const edit=(value:Partial<typeof current>)=>setEdited({...current,...value} as typeof current);
 const options=useCallback(async(signal:AbortSignal)=>SecondaryCraftSuppliersSchema.parse(await digitalRequest(
  `${path}?supplierSearch=${encodeURIComponent(search.trim())}`,'GET',undefined,undefined,{signal},
  )),[path,search]);
 const factories=useForegroundRead('secondary-craft-suppliers',item.canEdit&&current.mode==='outsourced'?search.trim():null,options);
 useForegroundWait(factories.foregroundKey);
 const values=factories.value?.items??[];
 const initialSupplier=item.supplier&&current.supplierId===item.supplier.supplierId&&!values.some(value=>value.supplierId===item.supplier?.supplierId)?[item.supplier]:[];
 const disabled=busy||uncertain!==null;
 const photo=original.display?.styleImage;
 const originalVersion=original.historical?`&version=${original.version}`:'';
 const send=async(attempt:Attempt)=>{
  if(writing.current)return;
  if(Date.now()-attempt.startedAt>=SUBMISSION_RECOVERY_WINDOW_MS){setError('已超过安全重试期限，请先核对本项最新版本。');return;}
  writing.current=true;
  setBusy(true);setError('');
  try{
   const raw=await digitalRequest(`${path}/${attempt.action}`,attempt.action==='draft'?'PUT':'POST',attempt.body,attempt.key);
   const checked=SecondaryCraftReceiptSchema.safeParse(raw);
   if(!checked.success||checked.data.target.rowId!==item.target.rowId||checked.data.receipt.action!==attempt.action
    ||checked.data.receipt.appliedVersion!==attempt.expected||checked.data.version<attempt.expected)
    throw new DigitalRequestError('保存回执未能确认，请核对本次原请求。',200,'INVALID_RESPONSE');
   setItem(checked.data);setEdited(null);setReason('');setUncertain(null);
  }catch(error){
   if(unknownWriteResult(error))setUncertain(attempt);
   setError(error instanceof Error?error.message:'本次操作未确认。');
  }finally{writing.current=false;setBusy(false);}
 };
 const submit=(action:'draft'|'submit'|'decision',decision?:'approved'|'returned')=>{
  if(disabled||writing.current)return;
  const schema=action==='decision'?SecondaryCraftDecisionSchema:action==='submit'?SecondaryCraftSubmissionSchema:SecondaryCraftDraftSchema;
  const result=schema.safeParse(action==='decision'?{decision,reason,expectedVersion:item.version}:{...current,expectedVersion:item.version});
  if(!result.success){setError(result.error.issues[0]?.message??'请核对报价输入。');return;}
  void send({action,body:result.data,expected:item.version+(action==='decision'?0:1),key:createClientRequestId(),startedAt:Date.now()});
 };
 return <>
  <h1>{item.target.label}报价</h1>
  {original.display&&<p>{[original.display.orderNumber,original.display.customerCode].filter(Boolean).join(' · ')}</p>}
  <p>{stageLabel[item.target.stage]} · 第 {item.target.round} 轮 · 资料 v{item.target.sourceVersion} · {labels[item.state]}{item.version>0&&` · 报价 v${item.version}`}</p>
  {photo&&<QuotationBasisImage key={photo.attachmentId} label="本版款图" href={urls.apiUrl(`digital-production/${path}/style-image/${photo.attachmentId}?documentVersion=${photo.documentVersion}${originalVersion}`)}/>}
  {item.target.instructions&&<p className="quotation-basis-instructions">{item.target.instructions}</p>}
  {item.versions.length>0&&<Selector label="原报价版本" value={version} isDisabled={disabled||edited!==null}
   options={[{value:'',label:'当前工艺报价'},...item.versions.map(saved=>({value:String(saved),label:`报价 v${saved}`}))]}
   onChange={value=>{location.assign(value?`${href}&version=${value}`:href);}}/>}
  {item.target.attachmentIds.map((id,index)=><div key={id}><QuotationBasisImage label={`本项工艺图 ${index+1}`} href={urls.apiUrl(`digital-production/${path}/attachments/${id}`)+(item.historical?`?version=${item.version}`:'')}/></div>)}
  {item.note&&<p>退回原因：{item.note}</p>}
  {item.state==='approved'&&item.draft?.unit!==item.target.pricingUnit&&<p>本版已批准，缺少客户报价所用单位的换算依据。</p>}
  {item.canEdit?<div className="budget-heading">
   <Selector label="制作方式" value={current.mode} options={modes} isDisabled={disabled} onChange={value=>{
    if(value==='in_house'||value==='outsourced')edit({mode:value,supplierId:null});
   }}/>
   {current.mode==='outsourced'&&<>
    <TextInput label="搜索合规加工厂" value={search} onChange={setSearch} isDisabled={disabled}/>
    <Selector label="加工厂" value={current.supplierId??''} isDisabled={disabled||factories.waiting}
     options={[...initialSupplier,...values].map(value=>({value:value.supplierId,label:`${value.name} · ${value.code}`}))}
     onChange={value=>edit({supplierId:value||null})}/>
    {factories.error&&<p role="alert">{factories.error.message} <Button label="重试读取加工厂" onClick={factories.retry}/></p>}
    {factories.value&&values.length===0&&<p>无符合条件的加工厂。</p>}
   </>}
   <TextInput label="工艺单价" value={current.unitPrice} onChange={value=>edit({unitPrice:value})} isDisabled={disabled}/>
   <TextInput label="计价单位" value={current.unit} onChange={value=>edit({unit:value})} isDisabled={disabled}/>
   <TextInput label="适用数量" value={current.applicableQuantity??''} onChange={value=>edit({applicableQuantity:value||null})} isDisabled={disabled}/>
   <TextInput label="报价说明" value={current.note} onChange={value=>edit({note:value})} isDisabled={disabled}/>
   <Button label="保存工艺报价草稿" variant="secondary" isDisabled={disabled} onClick={()=>submit('draft')}/>
   <Button label="提交伍云峰审批" isDisabled={disabled} onClick={()=>submit('submit')}/>
  </div>:item.draft&&<p>{item.draft.mode==='in_house'?'内做':item.supplier?.name??'加工厂待核'} · {item.draft.unitPrice} 元/{item.draft.unit}
   {item.draft.applicableQuantity&&` · 适用数量 ${item.draft.applicableQuantity}`}{item.draft.note&&` · ${item.draft.note}`}</p>}
  {item.canDecide&&<div className="budget-heading">
   <TextInput label="退回原因" value={reason} onChange={setReason} isDisabled={disabled}/>
   <Button label="退回本版工艺报价" variant="secondary" isDisabled={disabled} onClick={()=>submit('decision','returned')}/>
   <Button label="批准本版工艺报价" isDisabled={disabled} onClick={()=>submit('decision','approved')}/>
  </div>}
  {error&&<p role="alert">{error}</p>}
  {uncertain&&<Button label="重试原请求" isDisabled={busy} onClick={()=>void send(uncertain)}/>}
 </>;
}
