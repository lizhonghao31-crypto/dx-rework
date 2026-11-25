import {useCallback,useEffect,useState,useSyncExternalStore,type ReactNode} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Dialog,DialogHeader} from '@astryxdesign/core/Dialog';
import {Link} from '@astryxdesign/core/Link';
import {TextInput} from '@astryxdesign/core/TextInput';
import {SourcingTimelineResponseSchema,type SourcingTimelineEntry} from '@dx-rework/contracts';
import {JOURNEY_STAGES,type JourneyStageKey,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {DevelopmentMaterial} from '@dx-rework/contracts/digital-development';
import type {BulkWashingSheet} from '@dx-rework/contracts/bulk-washing';
import {OrderTimeRequestStateSchema} from '@dx-rework/contracts/order-time-requests';
import {FinanceNodeKeySchema} from '@dx-rework/contracts/reporting';
import {z} from 'zod';
import {createWebUrls} from '../url-contract.js';
import {cachedVerifiedSession,verifySession,registerSessionInvalidator,verifiedSessionIdentity} from './auth-session.js';
import {COCKPIT_VISIBLE_DOCUMENT_CATEGORIES,type CockpitDocumentCategory} from './cockpit-document-catalog.js';
import {
 createCockpitDocumentSnapshot,emptyCockpitDirectoryStates,type CockpitDocumentEntry,type CockpitDocumentReader,type CockpitDocumentSnapshot,
} from './cockpit-documents-model.js';
import {digitalChildDetailHref} from './digital-detail-route.js';
import {feedbackFetch,feedbackJson} from './request-response-feedback.js';
import {AstryxPageControls} from './astryx-page-controls.js';
import {AuxiliaryCatalogHistory} from './auxiliary-catalog-history.js';
import {ReceivingOriginalDirectory} from './receiving-original-records.js';
import {washingFactLabel} from './bulk-washing-actions.js';
import {useForegroundRead} from './use-foreground-read.js';
import {CockpitDocumentDirectoryRow,CockpitDocumentMore,CockpitDocumentStageTabs} from './cockpit-document-navigation.js';
import {OriginalDocumentDirectory,type OriginalDocumentRef} from './original-document-directory.js';
import {designerAstryxCss} from './designer-astryx.js';

const urls=createWebUrls(import.meta.env.BASE_URL);
const idle=emptyCockpitDirectoryStates(),noSubscription=()=>()=>{};
const read:CockpitDocumentReader=async(path,signal)=>{
 const response=await feedbackFetch(urls.apiUrl(path),{credentials:'include',cache:'no-store',signal});
 return feedbackJson(response,'GET',value=>value,(message,_code,status)=>Object.assign(new Error(message),{status}));
};

function originalHref(entry:CockpitDocumentEntry,returnTo:string){
 const url=entry.originalUrl||entry.url;
 if(!url?.startsWith('/ui/'))return '';
 const target=new URL(url,'https://local.invalid');
 if(/^\/ui\/pattern-room\/orders\/[^/]+$/.test(target.pathname)&&target.searchParams.has('round')){
  target.searchParams.set('readOnly','history');
 }else if(!(/^\/ui\/cutting\/orders\/[^/]+$/.test(target.pathname)&&target.searchParams.has('cuttingRecord')&&target.searchParams.has('cuttingVersion'))&&
  !(/^\/ui\/tasks\/[^/]+$/.test(target.pathname)&&target.searchParams.get('view')==='node-history'&&
   FinanceNodeKeySchema.safeParse(target.searchParams.get('node')).success&&z.string().uuid().safeParse(target.searchParams.get('entryId')).success)&&
  !(/^\/ui\/sourcing\/orders\/[^/]+$/.test(target.pathname)&&z.string().uuid().safeParse(target.searchParams.get('originalContract')).success)&&
  !(/^\/ui\/production-reporting\/[^/]+$/.test(target.pathname)&&z.string().uuid().safeParse(target.searchParams.get('originalReport')).success)&&
  !(target.pathname==='/ui/digital-production'&&(
   target.searchParams.has('factory')&&target.searchParams.has('originalFactory')&&target.searchParams.has('originalFactoryId')||
   target.searchParams.has('development')&&target.searchParams.has('originalTechnical')&&target.searchParams.has('originalTechnicalId')||
   (target.searchParams.has('materialSource')||target.searchParams.has('materialOrder'))&&target.searchParams.has('originalMaterial')&&target.searchParams.has('originalMaterialVersion')||
   Boolean(entry.originalUrl)&&z.string().uuid().safeParse(target.searchParams.get('task')).success&&target.searchParams.get('taskView')==='read'&&target.searchParams.size===2||
   (target.searchParams.has('bulk')||target.searchParams.has('closure'))&&z.string().uuid().safeParse(target.searchParams.get('originalEvent')).success
  )))return '';
 return digitalChildDetailHref(target.pathname+target.search,returnTo,urls.base);
}

function RecordEvidence({entry,session,returnTo}:{entry:CockpitDocumentEntry;session:CockpitDocumentSnapshot;returnTo:string}){
 const [error,setError]=useState(''),[reading,setReading]=useState(false);
 const load=()=>{const request=new AbortController();setReading(true);setError('');
  void session.loadEntry(entry,request.signal,true).catch((reason:unknown)=>{
   if((reason as Error)?.name!=='AbortError')setError('无法读取所选原记录，请重试。');
  }).finally(()=>setReading(false));
 };
 const href=originalHref(entry,returnTo);
 const children=[...(entry.originalEntries??[]),...(entry.children??[])];
 return <li><strong>{entry.label}</strong>
  {entry.note&&<p>{entry.note}</p>}
  {(entry.by||entry.at)&&<p>{[entry.by,entry.at].filter(Boolean).join(' · ')}</p>}
  {href&&<> <Link href={href}>查看原记录</Link></>}
  {entry.load&&<Button label={reading?'正在读取…':error?'重试读取原记录':'读取此记录'} isDisabled={reading} onClick={load}/>}
  {error&&<p role="alert">{error}</p>}
  {entry.files?.length?<ul>{entry.files.map(file=><li key={file.id}>{file.path
   ?<Link href={urls.apiUrl(file.path)} target="_blank" rel="noreferrer">{file.name}</Link>:file.name}</li>)}</ul>:null}
  {children.length?<ul>{children.map(child=><RecordEvidence key={child.id} entry={child} session={session} returnTo={returnTo}/>)}</ul>:null}
 </li>;
}

type ReaderCategory=CockpitDocumentCategory|'sourcing_history'|'time_requests'|'auxiliary_basis'|'related_records';
type Category={key:ReaderCategory;stage:JourneyStageKey;label:string};
const designerRelatedCategories:readonly Category[]=[...COCKPIT_VISIBLE_DOCUMENT_CATEGORIES,{key:'sourcing_history',stage:'preparation',label:'外发原节点与决策'},
 {key:'time_requests',stage:'creation',label:'本单时效申请与决定'},
 {key:'auxiliary_basis',stage:'development',label:'采用的共享辅料版本'},
 ...JOURNEY_STAGES.map(({key}):Category=>({key:'related_records',stage:key,label:'本阶段关联原记录'})),
];
const originalVersionKinds=['development','budget','instruction','quotation'] as const;
const exactKind=(key:ReaderCategory|null)=>originalVersionKinds.find(kind=>kind===key)??null;
const catalogueCategory=(key:ReaderCategory|null)=>COCKPIT_VISIBLE_DOCUMENT_CATEGORIES.find(item=>item.key===key)?.key??null;

function readDocumentSelection(query:URLSearchParams,order:OrderJourney):{stage:JourneyStageKey;category:ReaderCategory|null}{
 const chosen=designerRelatedCategories.find(item=>item.key===query.get('originalCategory')&&item.stage===query.get('originalStage'));
 const stage=JOURNEY_STAGES.find(item=>item.key===query.get('originalStage'))?.key;
 if(chosen&&stage)return {stage,category:chosen.key};
 if(stage)return {stage,category:null};
 // Older links from the exact-version directory may contain a page/search
 // without a category. Restore the directory, not a guessed original version.
 const pages=originalVersionKinds.filter(kind=>/^[1-9]\d*$/.test(query.get('original'+kind+'Page')??''));
 const kind=pages.length===1?pages[0]:'development';
 if(order.sourceId&&kind)return {stage:designerRelatedCategories.find(item=>item.key===kind)!.stage,category:kind};
 return {stage:'creation' as const,category:null};
}
const sourcingNodes={
 created:['created','跟单创建订单'],ie_quote:['ie_quote','IE 给价'],management_decision:['management','调价与选厂'],
 owner_decision:['owner','最终审批'],finance_reconciliation:['finance','财务核对'],
} as const;
const sourcingAudits={
 style_revision:['created','款号修订'],price_reapplication:['management','价格重新申请'],
 factory_change_request:['management','转厂申请'],factory_change_verification:['management','转厂审核'],
 exception_verification:['finance','差异处理'],
} as const;

function SourcingOriginals({order,session,returnTo}:{order:OrderJourney;session:CockpitDocumentSnapshot;returnTo:string}){
 const [requested,setRequested]=useState(0);
 const [result,setResult]=useState<Array<{id:string;entries:SourcingTimelineEntry[]|null}>|null>(null);
 useEffect(()=>{
  const signal=new AbortController();
  const caseIds=[...new Set([...order.links,...order.stages.flatMap(stage=>stage.nodes.flatMap(node=>node.records))]
   .filter(record=>record.domain==='sourcing'&&record.mode==='read'&&record.url).map(record=>record.id))];
  setResult(null);
  void Promise.all(caseIds.map(async id=>{
   try{
    const data=await session.readChecked(`sourcing/cases/${encodeURIComponent(id)}/timeline`,signal.signal,value=>SourcingTimelineResponseSchema.parse(value));
    return {id,entries:data.items};
   }catch{return {id,entries:null};}
  })).then(data=>{if(!signal.signal.aborted)setResult(data);});
  return()=>signal.abort();
 },[order,session,requested]);
 if(!result)return <p role="status">正在读取已关联的外发原节点…</p>;
 const records=result.flatMap(({id,entries})=>(entries??[]).flatMap(entry=>{
  const audit=Object.hasOwn(sourcingAudits,entry.kind)?sourcingAudits[entry.kind as keyof typeof sourcingAudits]:null;
  const destination=audit??(Object.hasOwn(sourcingNodes,entry.kind)?sourcingNodes[entry.kind as keyof typeof sourcingNodes]:null);
  if(!destination)return [];
  const [node,label]=destination;
  const query=new URLSearchParams({node,view:'node-history',[audit?'relatedEntryId':'entryId']:entry.entryId});
  const target=`/ui/sourcing/orders/${encodeURIComponent(id)}?${query}`;
  const href=digitalChildDetailHref(target,returnTo,urls.base);
  return href?[{key:`${id}:${entry.entryId}`,label:`${label} · v${entry.version}`,href}]:[];
 }));
 return <>
  {records.length>0?<ul>{records.map(record=><li key={record.key}><Link href={record.href}>{record.label}</Link></li>)}</ul>
   :result.every(item=>item.entries!==null)&&<p>暂无有权查看的外发原节点。</p>}
  {result.some(item=>item.entries===null)&&<p role="alert">部分外发记录无法读取。<Button label="重试读取外发记录" onClick={()=>setRequested(value=>value+1)}/></p>}
 </>;
}

function WashingOriginals({orderId,session,returnTo}:{orderId:string;session:CockpitDocumentSnapshot;returnTo:string}){
 const load=useCallback((signal:AbortSignal)=>session.readChecked(`digital-production/orders/${orderId}/bulk-washing`,signal,value=>{
  const sheet=value as BulkWashingSheet;
  if(sheet.orderId!==orderId||!Array.isArray(sheet.scopes))throw Error('洗水原记录与本单不一致。');
  return sheet;
 }),[orderId,session]);
 const reader=useForegroundRead(orderId,'original-washing',load);
 if(reader.error)return <p role="alert">无法读取本单洗水原记录。<Button label="重试读取洗水原记录" onClick={reader.retry}/></p>;
 if(!reader.value)return <p role="status">正在读取洗水原记录…</p>;
 const records=reader.value.scopes.flatMap(scope=>scope.facts.filter(fact=>fact.scopeId===scope.scopeId).map(fact=>({
  id:fact.id,label:[scope.label,washingFactLabel(fact),`${fact.quantity} 件`,...(fact.voided?['已作废']:[])].join(' · '),
  href:digitalChildDetailHref('/ui/digital-production?'+new URLSearchParams({
   factory:orderId,originalFactory:'washing',originalFactoryId:fact.id,originalWashingScope:scope.scopeId,
  }),returnTo,urls.base),
 })));
 return records.length>0?<section aria-label="洗水原记录"><ul>{records.map(record=><li key={record.id}>
  <Link href={record.href}>{record.label}</Link>
 </li>)}</ul></section>:null;
}

const timeDirectorySchema=z.object({sourceId:z.string().uuid(),page:z.number().int().positive(),pageSize:z.literal(15),total:z.number().int().nonnegative(),
 items:z.array(z.object({requestId:z.string().uuid(),version:z.number().int().positive(),state:OrderTimeRequestStateSchema})).max(15),
});
const timeStates={needs_designer:'待设计师提交',pending:'待处理',returned:'已退回',withdrawn:'已撤回',applied:'已生效'} as const;
function TimeOriginals({sourceId,session,returnTo}:{sourceId:string;session:CockpitDocumentSnapshot;returnTo:string}){
 const [page,setPage]=useState(()=>{
  const value=new URLSearchParams(location.search).get('originalTimePage');
  return value&&/^[1-9]\d*$/.test(value)&&Number(value)<=1000000?Number(value):1;
 }),[retry,setRetry]=useState(0);
 const [result,setResult]=useState<z.infer<typeof timeDirectorySchema>|null>(null),[error,setError]=useState(false);
 useEffect(()=>{
  const request=new AbortController();setResult(null);setError(false);
  void session.readChecked(`digital-production/sources/${sourceId}/order-time/original-requests?page=${page}`,request.signal,value=>{
   const data=timeDirectorySchema.parse(value);
   if(data.sourceId!==sourceId||data.page!==page)throw Error('原时效申请目录不属于当前单据');
   return data;
  }).then(data=>{
   if(!request.signal.aborted)setResult(data);
  }).catch(()=>{if(!request.signal.aborted)setError(true);});
  return()=>request.abort();
 },[sourceId,session,page,retry]);
 const source=new URL(returnTo,'https://local.invalid');
 if(page>1)source.searchParams.set('originalTimePage',String(page));else source.searchParams.delete('originalTimePage');
 const changePage=(value:number)=>{
  const target=new URL(location.href);
  if(value>1)target.searchParams.set('originalTimePage',String(value));else target.searchParams.delete('originalTimePage');
  history.replaceState(history.state,'',target);setPage(value);
 };
 if(!result)return error?<p role="alert">未能读取时效申请。<Button label="重试读取时效申请" onClick={()=>setRetry(value=>value+1)}/></p>:<p role="status">正在读取时效申请…</p>;
 return <>
  {result.items.length?<ul>{result.items.map(item=>{
   const href=digitalChildDetailHref('/ui/digital-production?'+new URLSearchParams({timeRequest:item.requestId,requestVersion:String(item.version)}),source.pathname+source.search,urls.base);
   return <li key={item.requestId}><Link href={href}>时效申请 · v{item.version} · {timeStates[item.state]}</Link></li>;
  })}</ul>:<p>{result.total?'本页没有时效申请，请返回有效页。':'暂无有权查看的时效申请。'}</p>}
  <AstryxPageControls page={page} pageSize={result.pageSize} total={result.total} onPageChange={changePage} label="本单时效申请分页"/>
 </>;
}

export function DesignerRelatedOriginals({order,materials,returnTo,onOriginal,onReady,relatedOriginals}:{
 order:OrderJourney;materials:readonly DevelopmentMaterial[];returnTo:string;onOriginal(ref:OriginalDocumentRef):void;onReady(ready:boolean):void;
 relatedOriginals(stage:JourneyStageKey,returnTo:string):ReactNode;
}){
 const [{stage,category},setDirectory]=useState(()=>readDocumentSelection(new URLSearchParams(location.search),order));
 const [more,setMore]=useState(false),[query,setQuery]=useState('');
 const [reading,setReading]=useState(false),[authError,setAuthError]=useState(false),[retry,setRetry]=useState(0);
 const [material,setMaterial]=useState<DevelopmentMaterial|null>(null);
 const [selection,setSelection]=useState<{order:OrderJourney;signature:string;snapshot:CockpitDocumentSnapshot}|null>(null);
 const current=selection?.order===order&&selection.signature===verifiedSessionIdentity(cachedVerifiedSession())?selection.snapshot:null;
 const states=useSyncExternalStore(current?.subscribe??noSubscription,current?.getSnapshot??(()=>idle),()=>idle);
 const selectedKind=exactKind(category),selectedReader=Boolean(category&&!selectedKind);
 useEffect(()=>registerSessionInvalidator(()=>{setSelection(null);setMaterial(null);}),[]);
 useEffect(()=>()=>selection?.snapshot.dispose(),[selection]);
 useEffect(()=>{
  if(!selectedReader||current)return;
  let active=true;setReading(true);setAuthError(false);
  void verifySession().then(verified=>{
   if(!active)return;
   if(verified==='denied'||verified.status!=='authorized'){setAuthError(true);return;}
   const signature=verifiedSessionIdentity(verified);
   setReading(false);
   setSelection({order,signature,snapshot:createCockpitDocumentSnapshot(order,read,()=>verifiedSessionIdentity(cachedVerifiedSession())===signature)});
  }).catch(()=>{if(active)setAuthError(true);}).finally(()=>{if(active)setReading(false);});
  return()=>{active=false;};
 },[selectedReader,order,Boolean(current),retry]);
 const currentCategory=selectedReader&&category!=='packing'?catalogueCategory(category):null;
 useEffect(()=>{if(currentCategory&&current)void current.load(currentCategory);},[currentCategory,current]);
 const remember=(nextStage:JourneyStageKey,nextCategory:ReaderCategory|null)=>{
  setMaterial(null);setDirectory({stage:nextStage,category:nextCategory});
  const target=new URL(location.href);
  target.searchParams.set('area','records');target.searchParams.set('originalStage',nextStage);
  if(nextCategory!=='time_requests')target.searchParams.delete('originalTimePage');
  if(nextCategory)target.searchParams.set('originalCategory',nextCategory);else target.searchParams.delete('originalCategory');
  history.replaceState(history.state,'',target);
 };
 const target=new URL(returnTo,'https://local.invalid');target.searchParams.set('originalStage',stage);
 if(category)target.searchParams.set('originalCategory',category);
 else target.searchParams.delete('originalCategory');
 const targetPath=target.pathname+target.search;
 const state=currentCategory?states[currentCategory]:null;
 const [exactReady,setExactReady]=useState(false);
 const ready=selectedKind?exactReady:!selectedReader||authError||Boolean(current&&(!state||state.phase==='ready'||state.phase==='error'));
 useEffect(()=>{onReady(ready);return()=>onReady(false);},[ready,onReady]);
 const visible=designerRelatedCategories.filter(item=>(!['sourcing_history','contract','packing','receiving'].includes(item.key)||order.orderId)&&
  (item.key!=='time_requests'||order.sourceId));
 const directoryRow=(item:Category,choose:(item:Category)=>void)=>{
  const key=catalogueCategory(item.key),data=current&&key?states[key]:null;
  const filled=data?.phase==='ready'&&data.data?.state==='created';
  const status=data?.phase==='error'?(data.denied?'不可查看':'读取失败'):data?.phase==='loading'?'读取中':
   data?.phase==='ready'&&data.data?.state==='missing'?'暂无记录':filled?'已创建':'待查看';
  return <CockpitDocumentDirectoryRow key={item.key} category={item.key} label={item.label} status={status}
   {...(data?.phase?{readState:data.phase}:{})} filled={filled} expanded={category===item.key} onOpen={()=>choose(item)}/>;
 };
 const closeMore=()=>{setMore(false);setQuery('');};
 const changeMore=(open:boolean)=>{if(!open)closeMore();};
 return <div className="designer-document-directory" aria-label="按阶段读取原单据">
  <div className="cockpit-document-directory">
   <CockpitDocumentStageTabs stage={stage} onSelect={value=>{if(value!==stage)remember(value,null);}}/>
   <div className="cockpit-document-priority" role="region" aria-label="本节点单据" tabIndex={0}>
    {visible.filter(item=>item.stage===stage).map(item=>directoryRow(item,chosen=>remember(chosen.stage,category===chosen.key?null:chosen.key)))}
   </div>
   <CockpitDocumentMore onOpen={()=>setMore(true)}/>
  </div>
  <Dialog isOpen={more} className="dx-designer-astryx designer-document-directory-more" onOpenChange={changeMore}>
   <style>{designerAstryxCss}</style><DialogHeader title="全部相关单据" onOpenChange={changeMore}/>
   <TextInput label="搜索单据类别" value={query} onChange={setQuery} ref={input=>{if(input)input.maxLength=100;}}/>
   {JOURNEY_STAGES.map(group=>{
    const inGroup=visible.filter(item=>item.stage===group.key&&item.label.includes(query.trim()));
    return inGroup.length?<section key={group.key} className="cockpit-document-stage"><h3>{group.label}</h3>
     {inGroup.map(item=><Button key={item.key} label={item.label} variant="ghost" onClick={()=>{remember(item.stage,item.key);closeMore();}}/>)}
    </section>:null;
   })}
   {!visible.some(item=>item.label.includes(query.trim()))&&<p>没有匹配的类别。</p>}
   <Button label="关闭" onClick={closeMore}/>
  </Dialog>
  <OriginalDocumentDirectory resource={{kind:order.sourceId?'source':'order',id:order.sourceId??order.orderId??order.id}} activeKind={selectedKind}
   onSelect={onOriginal} onReady={setExactReady} rememberInUrl/>
  {selectedReader&&(reading||current&&state?.phase==='loading')&&<p role="status">正在读取原单据…</p>}
  {selectedReader&&authError&&<p role="alert">登录状态未核实，未展示原记录。<Button label="重新核对身份" onClick={()=>setRetry(value=>value+1)}/></p>}
  {category==='related_records'&&current&&relatedOriginals(stage,targetPath)}
  {category==='sourcing_history'&&current&&<SourcingOriginals order={order} session={current} returnTo={targetPath}/>}
  {category==='factory'&&current&&order.orderId&&<WashingOriginals orderId={order.orderId} session={current} returnTo={targetPath}/>}
  {category==='time_requests'&&current&&order.sourceId&&<TimeOriginals sourceId={order.sourceId} session={current} returnTo={targetPath}/>}
  {current&&order.orderId&&(category==='receiving'||category==='packing')&&
   <ReceivingOriginalDirectory orderId={order.orderId} category={category} returnTo={targetPath} session={current}/>}
  {category==='auxiliary_basis'&&current&&<>
   {materials.some(item=>item.auxiliaryCatalog)?<ul>{materials.flatMap(item=>item.auxiliaryCatalog?[<li key={item.materialId}>
    <Button label={`${item.name} · 版本 ${item.auxiliaryCatalog.version}`} onClick={()=>setMaterial(item)}/>
   </li>]:[])}</ul>:<p>本版未保存共享辅料目录引用。</p>}
   {material?.auxiliaryCatalog&&materials.includes(material)&&<AuxiliaryCatalogHistory
    item={{id:material.auxiliaryCatalog.id,name:material.name}} exactVersion={material.auxiliaryCatalog.version} session={current} onClose={()=>setMaterial(null)}/>}
  </>}
  {state?.phase==='error'&&<p role="alert">{state.error}{!state.denied&&<Button label="重试读取目录" onClick={()=>void current?.load(currentCategory!)}/>}</p>}
  {current&&state?.data&&<>
   {state.data.note&&<p>{state.data.note}</p>}
   {state.data.entries.length?<ul>{state.data.entries.filter(entry=>category!=='receiving'||entry.load?.kind!=='receiving').map(entry=>
    <RecordEvidence key={entry.id} entry={entry} session={current} returnTo={targetPath}/>)}</ul>
    :state.phase==='ready'&&<p>{state.data.state==='missing'?'暂无记录':state.data.state==='not_applicable'?'当前没有此类业务来源':'是否存在原记录尚待核实'}</p>}
   {state.data.nextPage&&<div className="dx-pagination-frame"><Button label="读取下一页关联单据" size="sm"
    isDisabled={state.phase==='loading'} onClick={()=>void current.load(currentCategory!,true)}/></div>}
  </>}
 </div>;
}
