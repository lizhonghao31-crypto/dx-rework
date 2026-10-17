import {useEffect,useState,useCallback,useRef,type ReactNode} from 'react';
import {Button} from '@dx-rework/ui';
import type {DigitalTaskDocuments} from '@dx-rework/contracts/digital-production-tasks';
import type {DigitalOrder} from '@dx-rework/contracts/digital-production';
import {DigitalDevelopmentPanel} from './digital-development-panel.js';
import {DigitalBudgetPanel} from './digital-budget-panel.js';
import {ProductionInstructionPanel} from './production-instruction-panel.js';
import {DocumentChapterScope,DocumentToolbarScope} from './document-editor.js';
import {digitalRequest} from './digital-production-api.js';
import {digitalDetailClosePath} from './digital-detail-route.js';
import {DocumentGuardContext} from './use-digital-detail-navigation-guard.js';
import {documentCategories,documentVersionKeys,readDocumentVersion,readDigitalDetailContext,rememberDigitalDetailContext} from './digital-detail-context.js';
import './order-document-container.css';
import {DevelopmentFabricReportEntry} from './development-fabric-report.js';
import {RelatedDocumentRecords} from './related-document-records.js';
import {DevelopmentDocumentFacts} from './development-document-facts.js';

export const documentNames={development:'开发单',instruction:'大货制单',budget:'成本预算表'};
export type DocumentKind=keyof typeof documentNames;
export const documentChapters={development:[['development-images','款图与制作说明'],['development-basic','打板信息'],['development-materials','面辅料'],['development-sizes','尺寸表'],['development-labels','唛类'],['development-craft','工艺要求'],['development-handling','轮次与记录']],budget:[['budget-basic','基本资料'],['budget-section-0','主料'],['budget-section-1','辅料'],['budget-section-2','外发工序'],['budget-summary','费用与报价'],['budget-outsourcing','其他信息']]};
export type DocumentCategory=DocumentKind|'images'|'materials'|'results'|'customer'|'related';
const extraNames={images:'款图与工艺图',materials:'面辅料与检测报告',results:'工序成果',customer:'客户确认与寄样资料',related:'其他关联单据'};
type Reference={state:'available';id:string;version?:number|undefined}|{state:'unavailable'|'not_applicable'|'missing'|'draft'};
type Directory=Record<DocumentKind,Reference>;
export type DocumentSelection={kind:DocumentKind;id:string;version?:number|undefined};
/** Both task-adopted readers and legacy document entries use the original single editor. */
export function OrderDocumentContent({selection,readonly=false,chapter}:{selection:DocumentSelection;readonly?:boolean;chapter?:string|undefined}){
 const {kind,id,version}=selection;
 const [order,setOrder]=useState<DigitalOrder|null>(null),[error,setError]=useState('');
 useEffect(()=>{let live=true;setOrder(null);setError('');if(kind==='budget')void digitalRequest<DigitalOrder>(`orders/${id}`).then(value=>{if(live)setOrder(value);}).catch(reason=>{if(live)setError(reason.message);});return()=>{live=false;};},[kind,id]);
 const content=kind==='development'?<DigitalDevelopmentPanel key={id} sourceId={id} initialRound={version} embedded={readonly} contained onClose={()=>{}}/>:kind==='instruction'?<ProductionInstructionPanel key={`${id}:${version}`} orderId={id} initialVersion={version} embedded={readonly} contained onClose={()=>{}}/>:error?<p role="alert">{error}</p>:order?<DigitalBudgetPanel key={`${id}:${version}`} order={order} initialVersion={version} embedded={readonly} contained onClose={()=>{}}/>:<p role="status">正在读取已授权订单…</p>;
 return chapter&&kind!=='instruction'?<DocumentChapterScope chapter={chapter}>{content}</DocumentChapterScope>:content;
}

/** Old URLs are adapters: preserve their exact version and return source without a second editor. */
export function OrderDocumentContainer({initial,onClose,initialCategory,onCategory,onSlots,taskId,headerless=false,extraContent,onLeaveCheck}:{initial:DocumentSelection;onClose:()=>void;initialCategory?:DocumentCategory;headerless?:boolean;onLeaveCheck?:((check:(()=>Promise<boolean>)|null)=>void)|undefined;extraContent?:Partial<Record<DocumentCategory,ReactNode>>;taskId?:string|undefined;onCategory?:((category:DocumentCategory)=>void)|undefined;onSlots?:((targets:Partial<Record<DocumentCategory,HTMLElement>>)=>void)|undefined}){
 const [revision,setRevision]=useState(0);
 const guards=useRef(new Set<()=>Promise<boolean>>());
 const canLeave=useCallback(async()=>{for(const guard of guards.current)if(!await guard())return false;return true;},[]);
 useEffect(()=>{onLeaveCheck?.(canLeave);return()=>onLeaveCheck?.(null);},[canLeave,onLeaveCheck]);
 const [category,setCategory]=useState<DocumentCategory>(()=>{const query=new URLSearchParams(window.location.search),value=query.get('documentCategory');return initialCategory??(query.getAll('documentCategory').length===1&&(documentCategories as readonly string[]).includes(value??'')?value as DocumentCategory:initial.kind);});
 const [slot,setSlot]=useState<HTMLDivElement|null>(null);
 const slotRef=useCallback((node:HTMLDivElement|null)=>setSlot(node),[]);
 useEffect(()=>{onSlots?.(slot?{[category]:slot}:{});},[slot,category]);
 const [selection,setSelection]=useState(initial),[directory,setDirectory]=useState<Directory|null>(null),[error,setError]=useState('');
 const [chapter,setChapter]=useState<string>(()=>readDigitalDetailContext(window.location.search).chapter??(initial.kind==='budget'?'budget-basic':'development-images'));
 const selectChapter=(value:string)=>{setChapter(value);rememberDigitalDetailContext({documentChapter:value});};
 const [toolbar,setToolbar]=useState<HTMLElement|null>(null);
 useEffect(()=>{
  let live=true;setDirectory(null);setError('');
  void (taskId?digitalRequest<DigitalTaskDocuments>(`tasks/${taskId}/documents`).then(value=>Object.fromEntries(Object.entries(value).map(([kind,reference])=>[kind,reference.state==='published'?{state:'available',id:reference.id,version:reference.version}:{state:reference.state}])) as Directory):digitalRequest<Directory>(`document-directory/${initial.kind==='development'?'source':'order'}/${initial.id}`)).then(value=>{
   if(!live)return;setDirectory(value);
   const query=new URLSearchParams(window.location.search),context=readDigitalDetailContext(window.location.search),currentCategory=query.getAll('documentCategory').length===1&&(documentCategories as readonly string[]).includes(query.get('documentCategory')??'')?context.category:initialCategory??initial.kind;
   const kind=currentCategory==='images'?'development':Object.hasOwn(documentNames,currentCategory)?currentCategory as DocumentKind:null;
   if(!kind)return;const reference=value[kind];setSelection({kind,id:reference.state==='available'?reference.id:initial.id,version:reference.state==='available'?(taskId?readDocumentVersion(kind,window.location.search)??reference.version:kind===initial.kind?initial.version:reference.version):undefined});
   if(kind!=='instruction')setChapter(context.chapter&&documentChapters[kind].some(([id])=>id===context.chapter)?context.chapter:kind==='budget'?'budget-basic':'development-images');
  }).catch(reason=>{if(live)setError(reason.message);});return()=>{live=false;};
 },[initial.kind,initial.id,initial.version,taskId]);
 const remember=(next:DocumentSelection,category:DocumentCategory)=>{
  if(taskId||onSlots){rememberDigitalDetailContext({round:null,instructionVersion:null,budgetVersion:null,[documentVersionKeys[next.kind]]:next.version??null,documentCategory:category,documentChapter:next.kind!=='instruction'&&['development','budget','images'].includes(category)?next.kind==='budget'?'budget-basic':'development-images':null});return;}
  const back=digitalDetailClosePath(window.location.search,import.meta.env.BASE_URL),url=new URL(window.location.href);
  url.search=new URLSearchParams({[next.kind]:next.id,...(next.version?{[{development:'round',instruction:'instructionVersion',budget:'budgetVersion'}[next.kind]]:String(next.version)}:{}),...(back?{returnTo:back}:{}),...{documentCategory:category,...(next.kind!=='instruction'&&['development','budget','images'].includes(category)?{documentChapter:next.kind==='budget'?'budget-basic':'development-images'}:{})}}).toString();
  window.history.replaceState(window.history.state,'',url);
 };
 const choose=async(kind:DocumentKind)=>{const ref=directory?.[kind];if(!ref||!await canLeave())return;setCategory(kind);onCategory?.(kind);const next={kind,id:ref.state==='available'?ref.id:initial.id,version:ref.state==='available'?ref.version??(kind===initial.kind?initial.version:undefined):undefined};setSelection(next);if(ref.state==='available')remember(next,kind);setChapter(kind==='budget'?'budget-basic':'development-images');};
 const chooseCategory=async(next:DocumentCategory)=>{if(next==='images'){const ref=directory?.development;if(ref?.state!=='available')return;if(selection.kind!=='development'&&!await canLeave())return;const selected={kind:'development' as const,id:ref.id,version:ref.version??(initial.kind==='development'?initial.version:undefined)};setSelection(selected);remember(selected,next);setChapter('development-images');}else if(!await canLeave())return;setCategory(next);onCategory?.(next);if(next!=='images')remember(selection,next);};
 const source=directory?.development;
 const documentVisible=['development','instruction','budget','images'].includes(category);
 return <DocumentGuardContext.Provider value={guards.current}><section className="order-document-container" aria-label="本单资料">{!headerless&&<header><Button onClick={onClose}>返回来源</Button><h1>本单资料</h1></header>}<div className="order-document-layout"><nav aria-label="本单资料目录">{(Object.keys(documentNames) as DocumentKind[]).map(kind=><Button key={kind} aria-label={documentNames[kind]} aria-pressed={category===kind} disabled={!directory} onClick={()=>void choose(kind)}>{documentNames[kind]}{directory?.[kind]?.state==='unavailable'?' · 无权查看':directory?.[kind]?.state==='not_applicable'?' · 不适用':directory?.[kind]?.state==='draft'?' · 仅有草稿':directory?.[kind]?.state==='missing'?' · 尚无采用版本':''}</Button>)}{(Object.keys(extraNames) as Array<keyof typeof extraNames>).map(key=><Button key={key} aria-pressed={category===key} onClick={()=>void chooseCategory(key)}>{extraNames[key]}</Button>)}</nav><main className="task-document-reader">{error&&<p role="alert">资料目录读取失败：{error}</p>}{documentVisible&&category!=='images'&&selection.kind!=='instruction'&&<nav aria-label="单据章节">{documentChapters[selection.kind].map(([id,label])=><Button key={id} aria-pressed={chapter===id} onClick={()=>selectChapter(id!)}>{label}</Button>)}</nav>}{documentVisible?<DocumentToolbarScope target={toolbar}>{directory?.[selection.kind].state==='available'?<OrderDocumentContent key={`${selection.kind}:${selection.id}:${selection.version}`} selection={selection} chapter={chapter}/>:error?null:<p role="status">{!directory?'正在核对资料权限…':directory[selection.kind].state==='unavailable'?'当前身份无权查看此类资料':directory[selection.kind].state==='draft'?'仅有草稿，尚未发布可用版本':directory[selection.kind].state==='missing'?'本轮没有可读取的已发布版本':'尚无确定订单，不适用'}</p>}</DocumentToolbarScope>:<><div ref={slotRef}/>{extraContent?.[category]}{category==='materials'&&!extraContent?.materials&&!onSlots&&source?.state==='available'&&<DevelopmentFabricReportEntry onSaved={()=>setRevision(value=>value+1)} sourceId={source.id} round={initial.kind==='development'?initial.version:undefined}/>}{error?null:!directory?<p role="status">正在核对资料权限…</p>:category==='results'&&extraContent?.results?null:category==='related'?<RelatedDocumentRecords id={initial.id} round={initial.kind==='development'?initial.version:undefined}/>:source?.state==='available'?<DevelopmentDocumentFacts key={revision} sourceId={source.id} round={initial.kind==='development'?initial.version:undefined} category={category}/>:<p>没有可见的开发来源资料。</p>}</>}</main></div><footer ref={setToolbar}/></section></DocumentGuardContext.Provider>;
}
