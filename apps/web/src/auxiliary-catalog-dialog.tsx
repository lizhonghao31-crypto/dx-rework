import {ListPagination} from './list-pagination.js';
import {beginForegroundWait} from "./foreground-loading.js";
import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Button} from '@dx-rework/ui';
import {Button as AstryxButton} from '@astryxdesign/core/Button';
import {TextInput} from '@astryxdesign/core/TextInput';
import {TextArea} from '@astryxdesign/core/TextArea';
import {Selector} from '@astryxdesign/core/Selector';
import {Table} from '@astryxdesign/core/Table';
import {Dialog,DialogHeader} from '@astryxdesign/core/Dialog';
import {AuxiliaryQuerySchema,AuxiliaryPageSchema,AuxiliaryItemSchema,ChangeAuxiliaryReferencePricingSchema,CreateAuxiliarySchema,RenameAuxiliarySchema,DisableAuxiliarySchema,MergeAuxiliarySchema,type AuxiliaryItem} from '@dx-rework/contracts/auxiliary-catalog';
import {CatalogError,catalogRequest as request} from './auxiliary-catalog-api.js';
import {AuxiliaryCatalogHistory} from './auxiliary-catalog-history.js';
import {designerAstryxCss} from './designer-astryx.js';
import {createClientRequestId} from './client-request-id.js';
import {PatternDialog} from './pattern-dialog.js';
import {confirmInApp} from './system-dialog.js';
import {useDebouncedValue} from './use-debounced-value.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import './auxiliary-catalog-dialog.css';
type Action='create'|'rename'|'disable'|'merge'|'reference-pricing';
const actionTitles={create:'直接新增共享辅料',rename:'改名',disable:'停用',merge:'合并重复项','reference-pricing':'修改参考价'} as const;
const priceText=(price:AuxiliaryItem['referencePricing'])=>price?`¥${price.amount} / ${price.unit}`:'未记录';
function PageButton({children,disabled,variant='secondary',...props}:{children:string;disabled?:boolean;variant?:'primary'|'secondary';type?:'button'|'submit';onClick?():void}){
 return <AstryxButton {...props} label={children} isDisabled={Boolean(disabled)} variant={variant}/>;
}
function CatalogField({page,label,value,onChange,disabled,maxLength}:{page:boolean;label:string;value:string;onChange(value:string):void;disabled:boolean;maxLength:number}){
 return page?<TextInput label={label} value={value} onChange={onChange} isDisabled={disabled} ref={input=>{if(input)input.maxLength=maxLength;}}/>:<label>{label}<input value={value} maxLength={maxLength} disabled={disabled} onChange={event=>onChange(event.target.value)}/></label>;
}
function initialQuery(page:boolean){
 const params=new URLSearchParams(page?location.search:'');
 const parsed=AuxiliaryQuerySchema.safeParse({q:params.get('q')??'',page:params.get('page')??1,includeInactive:params.get('includeInactive')??'false'});
 return parsed.success?parsed.data:AuxiliaryQuerySchema.parse({});
}
export function AuxiliaryCatalogDialog({onSelect,onClose,disabled=false,presentation='dialog'}:{onSelect?:((item:AuxiliaryItem)=>void|boolean|Promise<boolean>)|undefined;onClose():void;disabled?:boolean;presentation?:'dialog'|'page'}){
 const pageView=presentation==='page',ActionButton=pageView?PageButton:Button;
 const initial=useRef(initialQuery(pageView));
 const [search,setSearch]=useState(initial.current.q),q=useDebouncedValue(search.trim(),250),[page,setPage]=useState(initial.current.page),[includeInactive,setIncludeInactive]=useState(initial.current.includeInactive),[refresh,setRefresh]=useState(0);
 const [result,setResult]=useState<ReturnType<typeof AuxiliaryPageSchema.parse>|null>(null),[readError,setReadError]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [resultKey,setResultKey]=useState<string|null>(null);
 const [busy,setBusy]=useState(false),[unknown,setUnknown]=useState(false),writing=useRef(false),input=useRef<HTMLInputElement>(null);
 const [action,setAction]=useState<Action|null>(null),[source,setSource]=useState<AuxiliaryItem|null>(null),[target,setTarget]=useState<AuxiliaryItem|null>(null);
 const [name,setName]=useState(''),[specification,setSpecification]=useState(''),[supplier,setSupplier]=useState(''),[kind,setKind]=useState<AuxiliaryItem['auxiliaryKind']>('普通辅料'),[reason,setReason]=useState('');
 const [referenceAmount,setReferenceAmount]=useState(''),[referenceUnit,setReferenceUnit]=useState('');
 const editorInitial=useRef(''),[historyItem,setHistoryItem]=useState<AuxiliaryItem|null>(null);
 const [reading,setReading]=useState(true);
 const quietRead=useRef(false),pendingRead=useRef(false);
 const applied=search.trim()===q;
 const requestKey=JSON.stringify([q,page,includeInactive,refresh]),currentResult=applied&&resultKey===requestKey;
 const attempt=useRef<{action:Action;path:string;body:unknown;key:string}|null>(null),locked=disabled||busy||unknown||reading||!currentResult;
 const canReadReferencePricing=result?.canReadReferencePricing===true;
 const dirty=action!==null&&JSON.stringify({name,specification,supplier,kind,reason,target:target?.id??null,referenceAmount,referenceUnit})!==editorInitial.current;
 useDigitalDetailNavigationGuard(unknown||dirty,busy,writing,unknown?'共享辅料操作结果仍未确认，离开不会撤销提交并会丢失本页重试标识。仍要离开？':'共享辅料资料尚未保存，仍要离开？');
 useEffect(()=>{if(!pageView)input.current?.focus();},[pageView]);
 useEffect(()=>{
  if(!pageView)return;
  const url=new URL(location.href);url.searchParams.set('q',search);url.searchParams.set('page',String(page));url.searchParams.set('includeInactive',String(includeInactive));
  history.replaceState(history.state,'',url);
 },[pageView,search,page,includeInactive]);
 useEffect(()=>{
  if(!applied){setReading(true);return;}
  const abort=new AbortController(),finish=quietRead.current?()=>{}:beginForegroundWait();
  quietRead.current=false;pendingRead.current=true;setReading(true);setReadError('');
  void request(`?${new URLSearchParams({q,page:String(page),includeInactive:String(includeInactive)})}`,'GET',undefined,undefined,abort.signal)
   .then(data=>{if(!abort.signal.aborted){setResult(AuxiliaryPageSchema.parse(data));setResultKey(requestKey);}})
   .catch(error=>{
    if(abort.signal.aborted)return;
    if(error instanceof CatalogError&&[401,403,404].includes(error.status??0))setResult(null);
    setReadError(error instanceof Error?error.message:'辅料目录尚未读取');
   }).finally(()=>{
    finish();
    if(!abort.signal.aborted){pendingRead.current=false;setReading(false);}
   });
  return()=>{abort.abort();finish();pendingRead.current=false;};
 },[q,page,includeInactive,refresh,applied,requestKey]);
 const canDiscard=async()=>!(unknown||dirty)||await confirmInApp(unknown?'目录提交仍未确认，离开不会撤销操作，并会丢失本页核对标识。仍要继续？':'目录资料尚未保存，仍要放弃本次编辑？');
 const edit=async(next:Action,item:AuxiliaryItem|null=null)=>{
  if(locked||!await canDiscard()||writing.current)return;
  const values={name:item?.name??search.trim(),specification:item?.specification??'',supplier:item?.supplier??'',kind:item?.auxiliaryKind??'普通辅料',reason:'',target:null,referenceAmount:item?.referencePricing?.amount??'',referenceUnit:item?.referencePricing?.unit??''};
  editorInitial.current=JSON.stringify(values);setAction(next);setSource(item);setTarget(null);setName(values.name);setSpecification(values.specification);setSupplier(values.supplier);setKind(values.kind);setReason('');setReferenceAmount(values.referenceAmount);setReferenceUnit(values.referenceUnit);setError('');attempt.current=null;
 };
 const complete=(item:AuxiliaryItem)=>{setUnknown(false);attempt.current=null;setAction(null);setSource(null);setNotice(onSelect?`共享辅料“${item.name}”的目录操作已取得回执；订单资料尚未保存。请搜索并选择当前有效条目。`:`共享辅料“${item.name}”的目录操作已保存；历史订单资料快照保持不变。`);quietRead.current=true;setRefresh(x=>x+1);};
 const send=async(prior:NonNullable<typeof attempt.current>)=>{
  if(writing.current)return;writing.current=true;setBusy(true);setError('');
  try{complete(AuxiliaryItemSchema.parse(await request(prior.path,'POST',prior.body,prior.key)));}
  catch(error){const uncertain=unknown||!(error instanceof CatalogError)||error.status===null||error.status===408||error.status>=500;setUnknown(uncertain);setError(uncertain?`${error instanceof CatalogError?error.message:'未收到有效目录回执'}；目录操作结果尚未确认，请保留本页标识先核对回执；订单材料尚未改变。`:error.message);}
  finally{writing.current=false;setBusy(false);}
 };
 const recover=async(retry=false)=>{const prior=attempt.current;if(!prior||writing.current)return;writing.current=true;setBusy(true);setError('');
  try{const data=await request(`/receipt?${new URLSearchParams({action:prior.action,key:prior.key})}`);if(data.receipt){complete(AuxiliaryItemSchema.parse(data.receipt));return;}if(!retry){setError('尚未查到原目录回执，结果仍未确认；请稍后核对，或沿原标识重试。');return;}}
  catch(error){setError(`原目录操作仍未确认：${error instanceof Error?error.message:'服务暂未响应'}。请保留原标识。`);return;}
  finally{writing.current=false;setBusy(false);}
  await send(prior);
 };
 const submit=async()=>{if(locked||!action)return;
  const referencePricing=referenceAmount.trim()||referenceUnit.trim()?{amount:referenceAmount.trim(),unit:referenceUnit.trim()}:null;
  const body=action==='create'?CreateAuxiliarySchema.safeParse({name,specification,supplier,auxiliaryKind:kind,...(canReadReferencePricing?{referencePricing}:{})})
   :action==='reference-pricing'?ChangeAuxiliaryReferencePricingSchema.safeParse({expectedVersion:source?.version,referencePricing,reason}):action==='rename'?RenameAuxiliarySchema.safeParse({expectedVersion:source?.version,name,reason}):action==='disable'?DisableAuxiliarySchema.safeParse({expectedVersion:source?.version,reason}):MergeAuxiliarySchema.safeParse({expectedVersion:source?.version,targetId:target?.id,expectedTargetVersion:target?.version,reason});
  if(!body.success){setError(body.error.issues[0]?.message??'请核对目录资料');return;}
  const path=action==='create'?'':`/${source!.id}/${action==='rename'?'versions':action}`;
  if(!attempt.current||attempt.current.path!==path||JSON.stringify(attempt.current.body)!==JSON.stringify(body.data))attempt.current={action,path,body:body.data,key:createClientRequestId()};await send(attempt.current);
 };
 const discardEditor=async()=>{
  if(busy||disabled||!await canDiscard()||writing.current)return;
  setAction(null);setSource(null);setTarget(null);setUnknown(false);setError('');attempt.current=null;
 };
 const close=async()=>{if(busy||disabled||!await canDiscard()||writing.current)return;onClose();};
 const choose=async(item:AuxiliaryItem)=>{if(locked||!await canDiscard()||writing.current)return;if(await onSelect?.(item)!==false)onClose();};
 const actions=(item:AuxiliaryItem)=><div className="auxiliary-catalog-actions">
  {action==='merge'
   ?<ActionButton type="button" disabled={locked||!item.active||Boolean(item.mergedInto)||item.id===source?.id} onClick={()=>setTarget(item)}>作为合并目标</ActionButton>
   :onSelect&&<ActionButton type="button" disabled={locked||!item.active||Boolean(item.mergedInto)} onClick={()=>void choose(item)}>选择此辅料</ActionButton>}
  {result?.canManage&&!item.mergedInto&&<>
   <ActionButton type="button" disabled={locked} onClick={()=>void edit('rename',item)}>改名</ActionButton>
   <ActionButton type="button" disabled={locked} onClick={()=>void edit('merge',item)}>合并重复项</ActionButton>
   {item.active&&canReadReferencePricing&&<ActionButton type="button" disabled={locked} onClick={()=>void edit('reference-pricing',item)}>修改参考价</ActionButton>}
   {item.active&&<ActionButton type="button" disabled={locked} onClick={()=>void edit('disable',item)}>停用</ActionButton>}
  </>}
  {pageView&&<ActionButton type="button" disabled={locked} onClick={()=>setHistoryItem(item)}>版本历史</ActionButton>}
 </div>;
 const columns=[
  {key:'name',header:'名称'},
  {key:'auxiliaryKind',header:'种类'},
  {key:'specification',header:'规格',renderCell:(item:AuxiliaryItem)=>item.specification||'未填写'},
  {key:'supplier',header:'供应商',renderCell:(item:AuxiliaryItem)=>item.supplier||'未填写'},
  ...(canReadReferencePricing?[{key:'referencePricing',header:'参考价 / 单位',renderCell:(item:AuxiliaryItem)=>priceText(item.referencePricing)}]:[]),
  {key:'version',header:'版本'},
  {key:'active',header:'状态',renderCell:(item:AuxiliaryItem)=>item.mergedInto?'已合并':item.active?'有效':'已停用'},
  {key:'id',header:'操作',renderCell:actions},
 ];
 const editor=action&&<form onSubmit={event=>{event.preventDefault();event.stopPropagation();void submit();}}>
  {!pageView&&<h3>{actionTitles[action]}</h3>}
  {source&&<div className="auxiliary-catalog-comparison"><div><h3>原辅料</h3><p>{source.name} · 版本 {source.version}</p><p>{source.auxiliaryKind} · 规格：{source.specification||'未填写'} · 供应方：{source.supplier||'未填写'}</p></div>
   {action==='merge'&&<div><h3>合并后保留</h3>{target?<><p>{target.name} · 版本 {target.version}</p><p>{target.auxiliaryKind} · 规格：{target.specification||'未填写'} · 供应方：{target.supplier||'未填写'}</p></>:<p>尚未选择</p>}</div>}
  </div>}
  {(action==='create'||action==='rename')&&<CatalogField page={pageView} label="辅料品名" value={name} onChange={setName} disabled={locked} maxLength={100}/>}
  {action==='create'&&<>
   <CatalogField page={pageView} label="规格" value={specification} onChange={setSpecification} disabled={locked} maxLength={100}/>
   <CatalogField page={pageView} label="供应方" value={supplier} onChange={setSupplier} disabled={locked} maxLength={100}/>
   {pageView?<Selector label="辅料分类" value={kind} options={['普通辅料','拉链','扁机']} onChange={value=>setKind(value as typeof kind)} isDisabled={locked}/>:<label>辅料分类<select value={kind} disabled={locked} onChange={event=>setKind(event.target.value as typeof kind)}>{['普通辅料','拉链','扁机'].map(value=><option key={value}>{value}</option>)}</select></label>}
  </>}
  {(action==='reference-pricing'||action==='create'&&canReadReferencePricing)&&<>
   {action==='reference-pricing'&&<p>原参考价：{priceText(source?.referencePricing)}</p>}
   <CatalogField page={pageView} label="参考单价（人民币、不含税）" value={referenceAmount} onChange={setReferenceAmount} disabled={locked} maxLength={17}/>
   <CatalogField page={pageView} label="参考价计价单位" value={referenceUnit} onChange={setReferenceUnit} disabled={locked} maxLength={100}/>
  </>}
  {action==='merge'&&<>
   <p>请搜索并选定重复项的保留目标。分类、规格及供应方须一致，原引用与历史名称保留。</p>
   {pageView&&<>
    <CatalogField page label="搜索合并目标" value={search} disabled={busy||unknown} maxLength={100} onChange={value=>{setSearch(value);setPage(1);}}/>
    <div className="auxiliary-catalog-table" aria-busy={reading||!currentResult}><div className="auxiliary-catalog-table-canvas"><Table data={result?.items??[]} idKey="id" columns={columns.slice(0,4).concat([{key:'id',header:'保留目标',renderCell:(item:AuxiliaryItem)=><ActionButton type="button" disabled={locked||!item.active||Boolean(item.mergedInto)||item.id===source?.id} onClick={()=>setTarget(item)}>作为合并目标</ActionButton>}])} density="balanced" aria-label="选择合并目标"/></div></div>
    <ListPagination page={page} totalPages={result&&!reading&&currentResult&&!readError?Math.max(1,Math.ceil(result.total/result.pageSize)):null} total={result&&!reading&&currentResult&&!readError?result.total:null} busy={busy||reading||!currentResult} onPageChange={setPage} ariaLabel="合并目标分页"/>
   </>}
  </>}
  {action==='disable'&&<p>停用后不能用于新选料，已保存的订单资料与历史版本继续保留。</p>}
  {action!=='create'&&(pageView?<TextArea label="本次变更原因" value={reason} onChange={setReason} isDisabled={locked} maxLength={500}/>:<label>本次变更原因<textarea value={reason} disabled={locked} maxLength={500} onChange={event=>setReason(event.target.value)}/></label>)}
  {error&&<p role="alert">{error}</p>}
  {unknown&&<section><p>原操作标识：{attempt.current?.key}</p>
   <ActionButton type="button" disabled={busy} onClick={()=>void recover()}>核对原目录回执</ActionButton>
   <ActionButton type="button" disabled={busy} onClick={()=>void recover(true)}>沿原标识重试目录操作</ActionButton>
  </section>}
  <div className="auxiliary-catalog-actions">
   <ActionButton type="button" disabled={busy} onClick={()=>void discardEditor()}>取消本次编辑</ActionButton>
   <ActionButton type="submit" variant="primary" disabled={locked}>{busy?'保存目录中…':'保存共享目录'}</ActionButton>
  </div>
 </form>;
 const content=<section className={pageView?'dx-designer-astryx auxiliary-catalog-page':'auxiliary-catalog-dialog'}>
  {pageView&&<style data-designer-style="astryx-v0.7.16">{designerAstryxCss}</style>}
  <header>{pageView?<h1>共享辅料目录</h1>:<h2>{onSelect?'选择共享辅料':'共享辅料目录'}</h2>}<p>{onSelect?'选择只填入本行资料；本轮是否使用仍由文员核料确认。':'有权岗位可直接新增、改名、合并重复项及停用；目录变更不会改写历史订单快照。'}</p></header>
  <div className="auxiliary-catalog-search">
   {pageView?<CatalogField page label="搜索品名、规格或供应方" value={search} maxLength={100} disabled={busy} onChange={value=>{setSearch(value);setPage(1);}}/>:<label>搜索品名、规格或供应方<input ref={input} value={search} maxLength={100} disabled={busy} onChange={event=>{setSearch(event.target.value);setPage(1);}}/></label>}
   <label><input type="checkbox" checked={includeInactive} disabled={busy} onChange={event=>{setIncludeInactive(event.target.checked);setPage(1);}}/>显示停用及已合并记录</label>
   {result?.canManage&&<ActionButton type="button" disabled={locked} onClick={()=>void edit('create')}>直接新增辅料</ActionButton>}
  </div>
  {notice&&<p role="status">{notice}</p>}
  {readError&&<p role="alert">{readError}<ActionButton type="button" disabled={busy||reading} onClick={()=>{if(!pendingRead.current)setRefresh(value=>value+1);}}>重新读取目录</ActionButton></p>}
  {!result&&!readError&&<p role="status">正在读取共享辅料…</p>}
  {pageView?<div className="auxiliary-catalog-table" aria-busy={reading||!currentResult}><div className="auxiliary-catalog-table-canvas"><Table data={result?.items??[]} idKey="id" columns={columns} density="balanced" aria-label="共享辅料目录" rowIndexStart={(page-1)*(result?.pageSize??15)+1}/></div></div>:<div className="auxiliary-catalog-results">{result?.items.map(item=><article key={item.id}>
   <div><strong>{item.name}</strong><span>{item.auxiliaryKind} · 规格：{item.specification||'未填写'} · 供应方：{item.supplier||'未填写'} · v{item.version}</span>{canReadReferencePricing&&<small>参考价：{priceText(item.referencePricing)}</small>}{!item.active&&<small>{item.mergedInto?'已合并，保留原引用':'已停用，旧订单快照保留'}</small>}</div>{actions(item)}
  </article>)}</div>}
  {result&&!reading&&currentResult&&!result.items.length&&<p>没有匹配的辅料。可换关键词，或由有权岗位直接新增。</p>}
  {result&&<ListPagination page={page} totalPages={!reading&&currentResult&&!readError?Math.max(1,Math.ceil(result.total/result.pageSize)):null} total={!reading&&currentResult&&!readError?result.total:null} busy={busy||reading||!currentResult} onPageChange={setPage} ariaLabel="辅料目录分页"/>}
  {pageView&&action?<Dialog isOpen onOpenChange={open=>{if(!open)void discardEditor();}} className="dx-designer-astryx auxiliary-catalog-editor">
   <style data-designer-style="astryx-v0.7.16">{designerAstryxCss}</style>
   <DialogHeader title={actionTitles[action]} onOpenChange={open=>{if(!open)void discardEditor();}}/>
   {editor}
  </Dialog>:editor}
  {historyItem&&<AuxiliaryCatalogHistory key={historyItem.id} item={historyItem} onClose={()=>setHistoryItem(null)}/>}
  {!pageView&&<footer><ActionButton type="button" disabled={busy||disabled} onClick={()=>void close()}>关闭辅料选择</ActionButton></footer>}
 </section>;
 return pageView?content:createPortal(<PatternDialog title="共享辅料" busy={busy||disabled} onClose={()=>void close()}>{content}</PatternDialog>,document.body);
}
