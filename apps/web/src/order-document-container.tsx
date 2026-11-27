import {beginForegroundWait} from "./foreground-loading.js";
import {developmentFieldChapter} from "./digital-development-validation.js";
import {DigitalReadFailure} from './digital-read-failure.js';
import {useEffect,useState,useCallback,useRef,type ReactNode} from 'react';
import {Button} from '@dx-rework/ui';
import type {DigitalTaskDocuments} from '@dx-rework/contracts/digital-production-tasks';
import type {DigitalOrder} from '@dx-rework/contracts/digital-production';
import type {DevelopmentSheet} from '@dx-rework/contracts/digital-development';
import {DigitalDevelopmentPanel,type DevelopmentSheetRead} from './digital-development-panel.js';
import {DigitalBudgetPanel} from './digital-budget-panel.js';
import {ProductionInstructionPanel} from './production-instruction-panel.js';
import {DocumentChapterScope,DocumentToolbarScope} from './document-editor.js';
import {digitalRequest} from './digital-production-api.js';
import {DocumentGuardContext} from './use-digital-detail-navigation-guard.js';
import {documentCategories,documentVersionKeys,isCurrentDocumentVersion,readDocumentKind,readDocumentVersion,readDigitalDetailContext,rememberDigitalDetailContext} from './digital-detail-context.js';
import './order-document-container.css';
import {DevelopmentFabricReportEntry} from './development-fabric-report.js';
import {RelatedDocumentRecords} from './related-document-records.js';
import {DevelopmentDocumentFacts} from './development-document-facts.js';

export const documentNames={development:'开发单',instruction:'大货制单',budget:'成本预算表'};
export type DocumentKind=keyof typeof documentNames;
export const documentChapters={development:[['development-images','款图与制作说明'],['development-basic','打板信息'],['development-materials','面辅料'],['development-sizes','尺寸表'],['development-labels','唛类'],['development-craft','工艺要求'],['development-handling','轮次与记录']],budget:[['budget-basic','基本资料'],['budget-section-0','主料'],['budget-section-1','辅料'],['budget-section-2','外发工序'],['budget-summary','费用与报价'],['budget-outsourcing','其他信息'],['budget-washing-fees','洗水费用补充']]};
export type DocumentCategory=DocumentKind|'images'|'materials'|'results'|'customer'|'related';
const extraNames={images:'款图与工艺图',materials:'面辅料与检测报告',results:'工序成果',customer:'客户确认与寄样资料',related:'其他关联单据'};
type Reference={state:'available';id:string;version?:number|undefined}|{state:'unavailable'|'not_applicable'|'missing'|'draft'};
type Directory=Record<DocumentKind,Reference>;
export type DocumentSelection={kind:DocumentKind;id:string;version?:number|undefined};
/** Both task-adopted readers and legacy document entries use the original single editor. */
export function OrderDocumentContent({selection,readonly=false,directDevelopmentEdit=false,chapter,wizardOwnsSections=false,onVersionChange,onChapterChange,onDevelopmentRead}:{onDevelopmentRead?:DevelopmentSheetRead|undefined;directDevelopmentEdit?:boolean;selection:DocumentSelection;readonly?:boolean;chapter?:string|undefined;wizardOwnsSections?:boolean;onChapterChange?:((chapter:string)=>void)|undefined;onVersionChange?:((version:number|undefined)=>void)|undefined}){
 const {kind,id,version}=selection;
 const [order,setOrder]=useState<DigitalOrder|null>(null),[error,setError]=useState('');
 useEffect(()=>{let live=true;setOrder(null);setError('');if(kind==='budget')void digitalRequest<DigitalOrder>(`orders/${id}`).then(value=>{if(live)setOrder(value);}).catch(reason=>{if(live)setError(reason.message);});return()=>{live=false;};},[kind,id]);
 const content=kind==='development'?<DigitalDevelopmentPanel key={id} sourceId={id} initialRound={version} onVersionChange={onVersionChange} onRead={onDevelopmentRead} embedded={readonly} directEdit={directDevelopmentEdit} contained onClose={()=>{}}/>:kind==='instruction'?<ProductionInstructionPanel key={`${id}:${version}`} orderId={id} initialVersion={version} onVersionChange={onVersionChange} embedded={readonly} contained onClose={()=>{}}/>:error?<p role="alert">{error}</p>:order?<DigitalBudgetPanel key={`${id}:${version}`} order={order} initialVersion={version} onVersionChange={onVersionChange} onChapterChange={onChapterChange} embedded={readonly} contained onClose={()=>{}}/>:<p role="status">正在读取已授权订单…</p>;
 return chapter&&kind!=='instruction'?<DocumentChapterScope chapter={wizardOwnsSections?null:chapter} onLocateField={!wizardOwnsSections&&kind==='development'&&onChapterChange?id=>{const next=developmentFieldChapter(id);if(next)onChapterChange(next);}:undefined}>{content}</DocumentChapterScope>:content;
}

/** Old URLs are adapters: preserve their exact version and return source without a second editor. */
export function OrderDocumentContainer({initial,onClose,initialCategory,onCategory,onSlots,taskId,headerless=false,headerActions,extraContent,onLeaveCheck,onDevelopmentRead,directDevelopmentEdit=false,developmentOnly=false}:{developmentOnly?:boolean;onDevelopmentRead?:DevelopmentSheetRead|undefined;directDevelopmentEdit?:boolean;initial:DocumentSelection;onClose:()=>void;initialCategory?:DocumentCategory;headerless?:boolean;headerActions?:ReactNode;onLeaveCheck?:((check:(()=>Promise<boolean>)|null)=>void)|undefined;extraContent?:Partial<Record<DocumentCategory,ReactNode>>;taskId?:string|undefined;onCategory?:((category:DocumentCategory)=>void)|undefined;onSlots?:((targets:Partial<Record<DocumentCategory,HTMLElement>>)=>void)|undefined}){
 const [revision,setRevision]=useState(0);
 const guards=useRef(new Set<()=>Promise<boolean>>());
 const canLeave=useCallback(async()=>{for(const guard of guards.current)if(!await guard())return false;return true;},[]);
 useEffect(()=>{onLeaveCheck?.(canLeave);return()=>onLeaveCheck?.(null);},[canLeave,onLeaveCheck]);
 const [category,setCategory]=useState<DocumentCategory>(()=>{const query=new URLSearchParams(window.location.search),value=query.get('documentCategory');return initialCategory??(query.getAll('documentCategory').length===1&&(documentCategories as readonly string[]).includes(value??'')?value as DocumentCategory:initial.kind);});
 const [slot,setSlot]=useState<HTMLDivElement|null>(null);
 const slotRef=useCallback((node:HTMLDivElement|null)=>setSlot(node),[]);
 useEffect(()=>{onSlots?.(slot?{[category]:slot}:{});},[slot,category]);
 const [selection,setSelection]=useState(initial),[directory,setDirectory]=useState<Directory|null>(null),[error,setError]=useState<Error|null>(null),[directoryRetry,setDirectoryRetry]=useState(0);
 const [chapter,setChapter]=useState<string>(()=>readDigitalDetailContext(window.location.search).chapter??(initial.kind==='budget'?'budget-basic':'development-images'));
 const selectChapter=(value:string)=>{setChapter(value);rememberDigitalDetailContext({documentChapter:value});};
 const [toolbar,setToolbar]=useState<HTMLElement|null>(null);
 useEffect(()=>{
  const controller=new AbortController(),finish=beginForegroundWait();
  setDirectory(null);setError(null);
  const read={signal:controller.signal};
  void (taskId?digitalRequest<DigitalTaskDocuments>(`tasks/${taskId}/documents`,"GET",undefined,undefined,read).then(value=>Object.fromEntries(Object.entries(value).map(([kind,reference])=>[kind,reference.state==='published'?{state:'available',id:reference.id,version:reference.version}:{state:reference.state}])) as Directory):digitalRequest<Directory>(`document-directory/${initial.kind==='development'?'source':'order'}/${initial.id}`,"GET",undefined,undefined,read)).then(value=>{
   if(controller.signal.aborted)return;setDirectory(value);
   const query=new URLSearchParams(window.location.search),context=readDigitalDetailContext(window.location.search),currentCategory=query.getAll('documentCategory').length===1&&(documentCategories as readonly string[]).includes(query.get('documentCategory')??'')?context.category:initialCategory??initial.kind;
   const kind=currentCategory==='images'?'development':Object.hasOwn(documentNames,currentCategory)?currentCategory as DocumentKind:readDocumentKind(window.location.search)??initial.kind;
   if(!kind)return;const reference=value[kind];if(reference.state==='available')setSelection({kind,id:reference.id,version:isCurrentDocumentVersion(kind,window.location.search)?undefined:readDocumentVersion(kind,window.location.search)??(taskId?reference.version:kind===initial.kind?initial.version:reference.version)});
   if(kind!=='instruction')setChapter(context.chapter&&documentChapters[kind].some(([id])=>id===context.chapter)?context.chapter:kind==='budget'?'budget-basic':'development-images');
  }).catch(reason=>{if(!controller.signal.aborted)setError(reason);}).finally(finish);
  return()=>{controller.abort();finish();};
 },[initial.kind,initial.id,initial.version,taskId,directoryRetry]);
 const remember=(next:DocumentSelection,category:DocumentCategory)=>{
  // The route identifies the original source/order/task. Directory references
  // identify content; a display category must never manufacture another entity.
  const primary=new URLSearchParams(window.location.search).has(next.kind);
  rememberDigitalDetailContext({documentKind:next.kind,...(next.version!==undefined||!primary?{[documentVersionKeys[next.kind]]:next.version??'current'}:{}),documentCategory:category,documentChapter:next.kind!=='instruction'&&['development','budget','images'].includes(category)?next.kind==='budget'?'budget-basic':'development-images':null});
 };
 const selectionFor=(kind:DocumentKind):DocumentSelection=>{const ref=directory![kind];if(ref.state!=='available')throw new Error('当前资料没有可读取实体');const current=isCurrentDocumentVersion(kind,window.location.search),chosen=readDocumentVersion(kind,window.location.search);return {kind,id:ref.id,version:current?undefined:chosen??(kind===selection.kind?selection.version:ref.version??(kind===initial.kind?initial.version:undefined))};};
 const versionChanged=(version:number|undefined)=>{setSelection(current=>({...current,version}));rememberDigitalDetailContext({documentKind:selection.kind,[documentVersionKeys[selection.kind]]:version??(new URLSearchParams(window.location.search).has(selection.kind)?null:'current')});};
 const choose=async(kind:DocumentKind)=>{const ref=directory?.[kind];if(!ref||!await canLeave())return;setCategory(kind);onCategory?.(kind);const next=ref.state==='available'?selectionFor(kind):selection;if(ref.state==='available')setSelection(next);remember(next,kind);setChapter(kind==='budget'?'budget-basic':'development-images');};
 const chooseCategory=async(next:DocumentCategory)=>{if(next==='images'){const ref=directory?.development;if(ref?.state!=='available')return;if(selection.kind!=='development'&&!await canLeave())return;const selected=selectionFor('development');setSelection(selected);remember(selected,next);setChapter('development-images');}else if(!await canLeave())return;setCategory(next);onCategory?.(next);if(next!=='images')remember(selection,next);};
 const sourceRound=selection.kind==='development'?selection.version:readDocumentVersion('development',window.location.search)??(initial.kind==='development'?initial.version:directory?.development.state==='available'?directory.development.version:undefined);
 const source=directory?.development;
 const documentVisible=['development','instruction','budget','images'].includes(category);
 const visibleKind=category==='images'?'development':Object.hasOwn(documentNames,category)?category as DocumentKind:null;
 const visibleReference=visibleKind?directory?.[visibleKind]:undefined;
 const sourceId=source?.state==='available'?source.id:undefined;
 const readsDevelopmentPanel=visibleKind==='development'&&selection.kind==='development';
 const readsDevelopmentFacts=!documentVisible&&category!=='related'&&!(category==='results'&&extraContent?.results);
 const [wizardDraft,setWizardDraft]=useState<{sourceId:string;round:number|undefined}|null>(null);
 // Resumed v10.1 drafts use the wizard step to determine visible fields.
 const wizardOwnsSections=readsDevelopmentPanel&&wizardDraft?.sourceId===selection.id&&wizardDraft.round===selection.version;
 const lastDevelopmentRead=useRef<{sourceId:string;round:number|undefined}|null>(null);
 const reportDevelopment=useCallback<DevelopmentSheetRead>((sheet,round)=>{
  lastDevelopmentRead.current={sourceId:sheet.sourceId,round};
  const guided=sheet.status==='draft'&&sheet.canEdit&&!sheet.revisionSource&&sheet.document?.workbenchSheet
   &&sheet.document.customerOrderDraft?.wizardStep!==undefined;
  setWizardDraft(guided?{sourceId:sheet.sourceId,round}:null);
  onDevelopmentRead?.(sheet,round);
 },[onDevelopmentRead]);
 const reuseDevelopmentRead=onDevelopmentRead||readsDevelopmentPanel?reportDevelopment:undefined;
 const needsDevelopmentRead=Boolean(reuseDevelopmentRead&&sourceId&&!readsDevelopmentPanel&&!readsDevelopmentFacts);
 useEffect(()=>{
  if(!needsDevelopmentRead||!sourceId||lastDevelopmentRead.current?.sourceId===sourceId&&lastDevelopmentRead.current.round===sourceRound)return;
  const abort=new AbortController();
  // Some categories show no development sheet. Its existing authorized read still controls the header action.
  void digitalRequest<DevelopmentSheet>(`sources/${sourceId}/development${sourceRound?`?round=${sourceRound}`:''}`,'GET',undefined,undefined,{signal:abort.signal})
   .then(sheet=>{if(!abort.signal.aborted)reportDevelopment(sheet,sourceRound);}).catch(()=>{/* Other category data remains available if the confirmation sheet cannot be read. */});
  return()=>abort.abort();
 },[needsDevelopmentRead,sourceId,sourceRound,reportDevelopment]);
 const Reader=developmentOnly?'div':'main';
 return <DocumentGuardContext.Provider value={guards.current}><section className="order-document-container" aria-label="本单资料">{!headerless&&<header><Button onClick={onClose}>返回来源</Button><h1>本单资料</h1>{headerActions}</header>}<div className={`order-document-layout${category==='budget'&&!developmentOnly?' order-document-layout--budget':''}`}>{!developmentOnly&&<nav aria-label="本单资料目录">{(Object.keys(documentNames) as DocumentKind[]).map(kind=><Button key={kind} aria-label={documentNames[kind]} aria-pressed={category===kind} disabled={!directory} onClick={()=>void choose(kind)}>{documentNames[kind]}{directory?.[kind]?.state==='unavailable'?' · 无权查看':directory?.[kind]?.state==='not_applicable'?' · 不适用':directory?.[kind]?.state==='draft'?' · 仅有草稿':directory?.[kind]?.state==='missing'?' · 尚无采用版本':''}</Button>)}{(Object.keys(extraNames) as Array<keyof typeof extraNames>).map(key=><Button key={key} aria-pressed={category===key} onClick={()=>void chooseCategory(key)}>{extraNames[key]}</Button>)}</nav>}<Reader className="task-document-reader">{error&&<DigitalReadFailure error={error} onRetry={()=>setDirectoryRetry(value=>value+1)} retryLabel="重试读取资料目录"/>}{documentVisible&&visibleReference?.state==='available'&&category!=='images'&&selection.kind!=='instruction'&&!wizardOwnsSections&&<nav aria-label="单据章节">{documentChapters[selection.kind].map(([id,label])=><Button key={id} aria-pressed={chapter===id} onClick={()=>selectChapter(id!)}>{label}</Button>)}</nav>}{documentVisible?<DocumentToolbarScope target={developmentOnly?null:toolbar}>{visibleReference?.state==='available'&&selection.kind===visibleKind?<OrderDocumentContent key={`${selection.kind}:${selection.id}:${selection.version}`} selection={selection} chapter={chapter} wizardOwnsSections={wizardOwnsSections} onChapterChange={selectChapter} onVersionChange={versionChanged} onDevelopmentRead={reuseDevelopmentRead} directDevelopmentEdit={directDevelopmentEdit&&category==='development'}/>:error?null:<p role="status">{!directory?'正在核对资料权限…':visibleReference?.state==='unavailable'?'当前身份无权查看此类资料':visibleReference?.state==='draft'?'仅有草稿，尚未发布可用版本':visibleReference?.state==='missing'?'本轮没有可读取的已发布版本':'尚无确定订单，不适用'}</p>}</DocumentToolbarScope>:<><div ref={slotRef}/>{extraContent?.[category]}{category==='materials'&&!extraContent?.materials&&!onSlots&&source?.state==='available'&&<DevelopmentFabricReportEntry onSaved={()=>setRevision(value=>value+1)} sourceId={source.id} round={sourceRound}/>}{error?null:!directory?<p role="status">正在核对资料权限…</p>:category==='results'&&extraContent?.results?null:category==='related'?<RelatedDocumentRecords id={initial.id} round={sourceRound}/>:source?.state==='available'?<DevelopmentDocumentFacts key={revision} sourceId={source.id} round={sourceRound} category={category} onRead={reuseDevelopmentRead}/>:<p>没有可见的开发来源资料。</p>}</>}</Reader></div><footer ref={setToolbar}/></section></DocumentGuardContext.Provider>;
}
