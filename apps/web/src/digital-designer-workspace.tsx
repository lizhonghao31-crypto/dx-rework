import {designerWorkspaceSection} from './digital-workspace-navigation.js';
import {ListPagination} from './list-pagination.js';
import {beginForegroundWait,useForegroundWait} from "./foreground-loading.js";
import {useDevelopmentCreationDraft} from './use-development-creation-draft.js';
import {developmentDraftRows,independentLocalDrafts,pendingDevelopmentCommands,unboundNumberedDraftKeys,type DevelopmentDraftRow,type SavedDevelopmentDraft,type DraftApprovalState} from './development-draft-list.js';
import {useInternalReturnScroll} from './use-internal-return-scroll.js';
import {Link} from '@astryxdesign/core/Link';
import {Button as AstryxButton} from '@astryxdesign/core/Button';
import {Dialog,DialogHeader} from '@astryxdesign/core/Dialog';
import {Selector} from '@astryxdesign/core/Selector';
import {DevelopmentEntryAction,DevelopmentEntryLanguage,DevelopmentEntryText} from './development-entry-controls.js';
import {designerAstryxCss as workspaceAstryxCss} from './designer-astryx.js';
import {registerSessionInvalidator,sessionCacheVersion} from './auth-session.js';
import {createClientRequestId} from './client-request-id.js';
import {publishTodoRead} from './todo-indicator-refresh.js';
import {developmentShippingLabel,developmentShippingTone} from './development-shipping-display.js';
import {confirmInApp} from './system-dialog.js';
import {useLiveSearch} from "./use-live-search.js";
import { SearchableSelect } from "./search-select.js";
import {DevelopmentOrderArchive} from "./development-order-archive.js";
import "./digital-kpi-density.css";
import { NavigationIcon } from "./navigation-icons.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button,Surface } from "@dx-rework/ui";
import { BusinessTable, FilterBar, KpiCard, Pagination, StatusBadge } from "@dx-rework/ui/production";
import { DESIGNER_BUSINESS_VIEWS, DEVELOPMENT_VIEWS, DevelopmentWorkspaceFilterSchema, type DevelopmentWorkspaceFilter, type DevelopmentWorkspaceItem, type DevelopmentWorkspaceResult } from "@dx-rework/contracts/digital-development-workspace";
import { DigitalIdSchema,type DigitalCustomer,type DigitalOrder } from "@dx-rework/contracts/digital-production";
import {DEVELOPMENT_GARMENTS,type DevelopmentDocument,type DevelopmentSheet} from "@dx-rework/contracts/digital-development";
import { DigitalRequestError,digitalRequest } from "./digital-production-api.js";
import {OrderDocumentContainer} from "./order-document-container.js";
import {DesignerHandlingItems,DesignerOrderWorkbench} from './designer-order-workbench.js';
import {OrderRushBadge} from './order-rush-badge.js';
import {digitalChildDetailHref} from './digital-detail-route.js';
import { DevelopmentCreateForm, type DevelopmentCreateIntent } from "./digital-development-create-form.js";
import {isDraftReservationPath} from './development-creation-command-path.js';
import { DEVELOPMENT_CREATION_TYPES, type DevelopmentWizardKind } from './development-creation-wizard.js';
import type { DigitalAccessOptions } from "./digital-production-access-panel.js";
import { navigateInternalPage } from "./internal-navigation.js";
import { createWebUrls } from "../url-contract.js";
import "./digital-development-workspace.css";

const urls = createWebUrls(import.meta.env.BASE_URL);
const date = (value: string | null | undefined) => !value ? "未登记" : /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : new Date(value).toLocaleDateString("sv-SE", {timeZone:"Asia/Shanghai"});
type SavedDevelopmentDraftPage={items:SavedDevelopmentDraft[];page:number;hasNext:boolean;total:number};
type DraftBucket='drafts'|'followup';
type DraftCount={scope:string;total:number|null;error?:true};
const draftApproval={pending:{label:'审批中',tone:'warning'},returned:{label:'已退回',tone:'danger'},
 withdrawn:{label:'已撤回',tone:'neutral'},needs_designer:{label:'待设计师处理',tone:'info'}} as const satisfies Record<DraftApprovalState,{label:string;tone:'warning'|'danger'|'neutral'|'info'}>;
type DraftReceiptResolution={page:SavedDevelopmentDraftPage;keys:string;resolvedSourceIds:Set<string>;unverified:boolean};
const viewLabel = (item: DevelopmentWorkspaceItem) => DEVELOPMENT_VIEWS.find(view => view.key === item.view)?.label;
function initialFilter(): DevelopmentWorkspaceFilter {
  const parsed = DevelopmentWorkspaceFilterSchema.safeParse(Object.fromEntries([...new URLSearchParams(window.location.search)].filter(([key]) => ["page", "search", "customer", "view", "businessView", "designer", "startDate", "endDate"].includes(key))));
  return parsed.success ? parsed.data : DevelopmentWorkspaceFilterSchema.parse({});
}
function StyleImage({item}: {item: DevelopmentWorkspaceItem}) {
  const [failed, setFailed] = useState(false);
  const image = item.journey.styleImageUrl;
  return image && !failed ? <img loading="lazy" decoding="async" className="development-style-image" alt={`${item.journey.designStyleNo} 款图`} src={urls.apiUrl(image.replace(/^\/api\//,''))} onError={() => setFailed(true)}/> : <span className="development-style-placeholder">{failed ? "款图不可用" : "暂无款图"}</span>;
}
export function DigitalDesignerWorkspace(){
 return <DevelopmentEntryLanguage><DigitalDesignerWorkspaceContent/></DevelopmentEntryLanguage>;
}
function DigitalDesignerWorkspaceContent() {
  const [filter, setFilter] = useState(initialFilter), [result, setResult] = useState<DevelopmentWorkspaceResult | null>(null);
  const [appliedListQuery,setAppliedListQuery]=useState<string|null>(null);
  const [options, setOptions] = useState<{independentCraftsEnabled?:boolean;orderTimeEnabled?:boolean;workbenchNumberedCreation?:boolean;creationEnabled: boolean; customers: DigitalCustomer[]; minimumInitialCustomerDate?:string;serverToday?:string} | null>(null), [access, setAccess] = useState<DigitalAccessOptions | null>(null);
  const [intent, setIntent] = useState<DevelopmentCreateIntent | null>(null), [confirm, setConfirm] = useState<DevelopmentWorkspaceItem | null>(null);
  const [choosingType,setChoosingType]=useState(false);
  const [newType,setNewType]=useState<DevelopmentWizardKind|null>(null);
  const [newGarment,setNewGarment]=useState<DevelopmentDocument['template']|null>(null);
  const [newRush,setNewRush]=useState<boolean|null>(null);
  const openCreationChoices=()=>{setNewType(null);setNewGarment(null);setNewRush(null);setChoosingType(true);};
  const creation=useDevelopmentCreationDraft();
  const [draftPage,setDraftPage]=useState(1);
  const [followupPage,setFollowupPage]=useState(1),[draftBucket,setDraftBucket]=useState<DraftBucket>('drafts');
  const [drafts,setDrafts]=useState<SavedDevelopmentDraftPage|null>(null),[draftError,setDraftError]=useState('');
  const [draftCounts,setDraftCounts]=useState<Partial<Record<DraftBucket,DraftCount>>>({});
  const draftCountCache=useRef<Partial<Record<DraftBucket,DraftCount>>>({});
  const rememberDraftCount=useCallback((bucket:DraftBucket,count:DraftCount)=>{
    draftCountCache.current={...draftCountCache.current,[bucket]:count};
    setDraftCounts(draftCountCache.current);
  },[]);
  const [draftReceiptResolution,setDraftReceiptResolution]=useState<DraftReceiptResolution|null>(null);
  const [appliedDraftQuery,setAppliedDraftQuery]=useState<string|null>(null);
  const [creationMessage,setCreationMessage]=useState(''),[creationBusy,setCreationBusy]=useState(false);
  const discardKeys=useRef(new Map<string,{version:number;approvalRequestId?:string;approvalVersion?:number;key:string}>());
  const [confirmSheet,setConfirmSheet]=useState<DevelopmentSheet|undefined>(),[preparingConfirm,setPreparingConfirm]=useState(false),[confirmError,setConfirmError]=useState("");
  const [confirmedOrderId,setConfirmedOrderId]=useState<string|null>(null);
  const [confirmedOrder,setConfirmedOrder]=useState<DigitalOrder|null>(null),[confirmedOrderError,setConfirmedOrderError]=useState(""),[orderRetry,setOrderRetry]=useState(0);
  const preparing=useRef(false),openingCreation=useRef(false),detailLeaveCheck=useRef<(()=>Promise<boolean>)|null>(null);
  const rememberLeaveCheck=useCallback((check:(()=>Promise<boolean>)|null)=>{detailLeaveCheck.current=check;},[]);
  const [error, setError] = useState(""), [accessError,setAccessError]=useState(''), [refresh, setRefresh] = useState(0);
  const [listVersion,setListVersion]=useState(0);
  const [sheets, setSheets] = useState<Record<string, DevelopmentSheet>>({}), [sheetErrors, setSheetErrors] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("selected"));
  const initialSelection=useRef(selectedId);
  const [collapsed, setCollapsed] = useState(false), [search, setSearch] = useState(filter.search);
  const [orders,setOrders]=useState<Record<string,DigitalOrder>>({}),[orderErrors,setOrderErrors]=useState<Record<string,string>>({});
  const liveSearch=useLiveSearch(search,filter.search,value=>update({search:value}));
  const latestListScope=useRef<string|null>(null),listReading=useRef(false),manualRefresh=useRef(false),quietListRefresh=useRef(false);
  const updateEditorFacts=useCallback(()=>{quietListRefresh.current=true;setListVersion(value=>value+1);},[]);
  const retryList=()=>{
    if(listReading.current||manualRefresh.current)return;
    manualRefresh.current=true;setRefresh(value=>value+1);
  };
  useForegroundWait(creationBusy?"development-draft-open":preparingConfirm?"development-order-confirm-read":undefined);
  const query = new URLSearchParams(window.location.search);
  const editor = query.get("development");
  const round = Number(query.get("round")) || undefined;
  const workbench = Boolean(editor&&query.getAll('section').length===1&&query.get('section')==='workspace'
    &&(!query.has('documentCategory')||query.get('documentCategory')==='development'));
  const creatingPage = !editor && designerWorkspaceSection(query) === "create";
  const requestedDrafts = creatingPage ? query.getAll('creationDraft') : [];
  const requestedDraft = requestedDrafts.length===1&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedDrafts[0]!)
    ? requestedDrafts[0]! : null;
  const displayedIntent=creatingPage?creation.visibleView?.intent??null:intent;
  const showCreationView=Boolean((creatingPage||editor&&confirm)&&displayedIntent);
  const setDraftLocation=(id?:string)=>{
    const current=new URL(window.location.href);
    if(id)current.searchParams.set('creationDraft',id);
    else current.searchParams.delete('creationDraft');
    window.history.replaceState(window.history.state,'',current.pathname+current.search);
  };
  // Authorization resolving for the current session must not close a region
  // the user has already opened. Actual session invalidation resets the view.
  const [editorSession,setEditorSession]=useState(0);
  const [openedSheet,setOpenedSheet]=useState<{sheet:DevelopmentSheet;requestedRound:number|undefined;refresh:number}|null>(null);
  const lastOpenedSheet=useRef<DevelopmentSheet|null>(null);
  const rememberOpenedSheet=useCallback((sheet:DevelopmentSheet,requestedRound:number|undefined)=>{
    const prior=lastOpenedSheet.current;lastOpenedSheet.current=sheet;
    setOpenedSheet({sheet,requestedRound,refresh});
    if(prior?.sourceId===sheet.sourceId&&prior.roundNumber===sheet.roundNumber&&prior.version!==sheet.version)updateEditorFacts();
  },[refresh,updateEditorFacts]);
  const contextUrl = (parameters: Record<string, string> = {}, next = filter, selected = selectedId) => {
    const query = new URLSearchParams({workspace: "designer", section: creatingPage ? "create" : "workspace", ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)])), ...(selected ? {selected} : {}), ...parameters});
    return `${urls.pageUrl("ui/digital-production")}?${query}`;
  };
  useEffect(() => {
    let live=true;setConfirmedOrder(null);setConfirmedOrderError("");
    if(confirmedOrderId)void digitalRequest<DigitalOrder>(`orders/${confirmedOrderId}`).then(order=>{if(live)setConfirmedOrder(order);}).catch(reason=>{if(live)setConfirmedOrderError(reason.message);});
    return()=>{live=false;};
  },[confirmedOrderId,orderRetry]);
  const scoped={...(editor?{search:editor,view:'all',page:1}:filter),...(!editor||workbench?{layout:'workbench'}:{})};
  const configured=new URLSearchParams(Object.entries(scoped).filter(([,value])=>value!==undefined&&value!=="").map(([key,value])=>[key,String(value)]));
  configured.sort();
  const listQuery=configured.toString();
  const activeDraftPage=draftBucket==='drafts'?draftPage:followupPage;
  const setActiveDraftPage=draftBucket==='drafts'?setDraftPage:setFollowupPage;
  const inactiveDraftBucket=draftBucket==='drafts'?'followup':'drafts';
  const draftCountScope=JSON.stringify([access?.actorId,filter.search,refresh]);
  const draftQuery=new URLSearchParams({page:String(activeDraftPage),search:filter.search,bucket:draftBucket}).toString();
  const draftReadKey=JSON.stringify([draftCountScope,draftQuery]);
  const listReady=!creatingPage&&!editor&&!liveSearch.pending&&result!==null&&appliedListQuery===listQuery;
  useInternalReturnScroll(listReady);
  useEffect(()=>{
    if(!listReady||!initialSelection.current)return;
    const selected=initialSelection.current;
    const frame=requestAnimationFrame(()=>{
      initialSelection.current=null;
      if(document.activeElement!==document.body)return;
      const row=document.getElementById(`development-open-${selected}`);
      (row??document.querySelector<HTMLElement>('.development-list-panel .development-search-field input'))?.focus({preventScroll:true});
      if(row)row.scrollIntoView({block:'nearest'});
    });
    return()=>cancelAnimationFrame(frame);
  },[listReady]);
  useEffect(()=>{
    if(creatingPage||(!editor&&liveSearch.pending))return;
    const abort=new AbortController(),finish=quietListRefresh.current?()=>{}:beginForegroundWait();
    quietListRefresh.current=false;listReading.current=true;manualRefresh.current=false;
    const scope=editor??"workspace";
    if(latestListScope.current!==scope){latestListScope.current=scope;setResult(null);}
    setError("");
    void digitalRequest<DevelopmentWorkspaceResult>(`workspaces/designer?${listQuery}`,"GET",undefined,undefined,{signal:abort.signal})
      .then(data=>{if(!abort.signal.aborted){setResult(data);setAppliedListQuery(listQuery);}}).catch(error=>{
        if(abort.signal.aborted)return;
        if(error instanceof DigitalRequestError&&[401,403,404].includes(error.status??0))setResult(null);
        setError(error instanceof Error?error.message:"开发档案读取失败");
      }).finally(()=>{
        finish();
        if(!abort.signal.aborted)listReading.current=false;
      });
    return()=>{abort.abort();finish();listReading.current=false;};
  },[creatingPage,editor,listQuery,refresh,listVersion,liveSearch.pending]);
  useEffect(()=>{
    let live=true;const abort=new AbortController(),read={signal:abort.signal};setAccessError('');
    void Promise.all([digitalRequest<typeof options>('options','GET',undefined,undefined,read),digitalRequest<DigitalAccessOptions>('access/options','GET',undefined,undefined,read)])
      .then(async([nextOptions,nextAccess])=>{
        if(!live)return;
        const restored=creatingPage?await creation.load(nextAccess,Boolean(nextOptions?.creationEnabled),requestedDraft,abort.signal):null;
        if(!live)return;
        setOptions(nextOptions);setAccess(nextAccess);
        if(restored)setIntent(restored.intent);
        if(creatingPage&&requestedDrafts.length&&!requestedDraft)setCreationMessage('草稿链接无效，请从草稿列表重新选择');
      })
      .catch(reason=>{if(live)setAccessError(reason.message);});
    return()=>{live=false;abort.abort();};
  },[editor,creatingPage,refresh]);
  useEffect(()=>registerSessionInvalidator(()=>{creation.reset();discardKeys.current.clear();quietListRefresh.current=true;setResult(null);setSheets({});setOrders({});setDrafts(null);setDraftReceiptResolution(null);setDraftError('');draftCountCache.current={};setDraftCounts({});setDraftBucket('drafts');setDraftPage(1);setFollowupPage(1);setIntent(null);setConfirm(null);setConfirmSheet(undefined);setOpenedSheet(null);setAccess(null);setOptions(null);setEditorSession(value=>value+1);setRefresh(value=>value+1);}),[]);
  useEffect(() => {
    let live = true; setSheets({}); setSheetErrors({});setOrders({});setOrderErrors({});
    const item = editor?undefined:result?.items.find(value => value.journey.id === selectedId);
    if (item?.journey.sourceId) {
      const source = item.journey.sourceId;
      void digitalRequest<DevelopmentSheet>(`sources/${source}/development${item.journey.sourceVersion && item.journey.selectedRound ? `?round=${item.journey.selectedRound}` : ""}`)
        .then(sheet => {if (live) setSheets(current => ({...current, [item.journey.id]:sheet}));})
        .catch(reason => {if (live) setSheetErrors(current => ({...current, [item.journey.id]:reason.message}));});
    }
    if(item?.journey.orderId){const id=item.journey.orderId;void digitalRequest<DigitalOrder>(`orders/${id}`).then(order=>{if(live)setOrders({[item.journey.id]:order});}).catch(reason=>{if(live)setOrderErrors({[item.journey.id]:reason.message});});}
    return () => {live = false;};
  }, [result, selectedId, editor]);
  const update = (patch: Partial<DevelopmentWorkspaceFilter>) => {
    if(patch.view==="draft"){void navigateInternalPage(contextUrl({section:"create"}, {...filter,view:"all",page:1}, null));return;}
    const parsed = DevelopmentWorkspaceFilterSchema.safeParse({...filter, page: 1, ...patch});
    if (!parsed.success) {setError(parsed.error.issues[0]?.message ?? "筛选条件无效"); return;}
    const next = parsed.data;
    if(JSON.stringify(next)===JSON.stringify(filter))return;
    if(creatingPage&&next.search!==filter.search){setDraftPage(1);setFollowupPage(1);}
    setFilter(next);setSelectedId(null);setCollapsed(false);
    window.history.replaceState(window.history.state, "", contextUrl({}, next, null));
  };
  const select = (id: string) => {setSelectedId(id); setCollapsed(false); window.history.replaceState(window.history.state, "", contextUrl({}, filter, id));};
  const selected = result?.items.find(item => item.journey.id === selectedId), sheet = selected ? sheets[selected.journey.id] : undefined;
  const openUrl = (item: DevelopmentWorkspaceItem) => contextUrl({development:item.journey.sourceId!, ...(item.journey.selectedRound && item.journey.sourceVersion ? {round:String(item.journey.selectedRound)} : {})}, filter, item.journey.id);
  const editorItem=result?.items.find(item=>item.journey.sourceId===editor),editorSheet=openedSheet?.refresh===refresh&&openedSheet.sheet.sourceId===editor&&openedSheet.requestedRound===round?openedSheet.sheet:undefined;
  const canConfirm=Boolean(editorItem&&!editorItem.journey.orderId&&editorSheet&&!editorSheet.productionOrderId
    &&(editorSheet.preorderPublication?options?.workbenchNumberedCreation&&editorSheet.canEdit:editorItem.canConfirm&&editorSheet.status==='published')
    &&(!workbench||editorSheet.canEdit&&(editorSheet.roundNumber??1)===(editorSheet.latestRoundNumber??1))&&options?.creationEnabled&&access?.create&&!confirmedOrderId);
  const openCreation=async(action:()=>ReturnType<typeof creation.open>,selectedView?:string)=>{
    if(openingCreation.current)return;
    openingCreation.current=true;setCreationBusy(true);setCreationMessage('');
    try{
      // Keep the explicit selection across an immediate reload while authority is rechecked.
      if(selectedView)setDraftLocation(selectedView);
      const next=await action();
      if(next){
        setDraftLocation(next.viewId);
        setIntent(next.intent);setConfirm(null);setChoosingType(false);
      }
    }
    catch(reason){if(selectedView&&new URL(location.href).searchParams.get('creationDraft')===selectedView)setDraftLocation();setChoosingType(false);setCreationMessage(reason instanceof Error?reason.message:'本页创建资料尚未核实');}
    finally{openingCreation.current=false;setCreationBusy(false);}
  };
  const beginCreation=()=>{
    if(!newType||!newGarment||newRush===null)return;
    const choices={template:newGarment,rush:newRush};
    void openCreation(()=>creation.open(undefined,newType==='development'?'development':'certain_order',newType==='preorder',choices));
  };
  useEffect(()=>{
    if(!creatingPage||liveSearch.pending||intent||!options?.creationEnabled||!access?.create)return;
    const abort=new AbortController(),finish=beginForegroundWait();setDraftError('');
    void digitalRequest<SavedDevelopmentDraftPage>(`sources/drafts?${draftQuery}`,'GET',undefined,undefined,{signal:abort.signal})
      .then(result=>{
        if(abort.signal.aborted)return;
        rememberDraftCount(draftBucket,{scope:draftCountScope,total:result.total});
        const last=Math.max(1,Math.ceil(result.total/15));
        if(activeDraftPage>last){setActiveDraftPage(last);return;}
        setDrafts(result);setAppliedDraftQuery(draftReadKey);
      })
      .catch(reason=>{
        if(abort.signal.aborted)return;
        rememberDraftCount(draftBucket,{scope:draftCountScope,total:null,error:true});
        setDrafts(null);setDraftError(reason instanceof Error?reason.message:'未能读取开发草稿');
      }).finally(finish);
    return()=>{abort.abort();finish();};
  },[creatingPage,draftQuery,draftReadKey,draftBucket,draftCountScope,activeDraftPage,setActiveDraftPage,liveSearch.pending,intent,
    options?.creationEnabled,access?.create,rememberDraftCount]);
  useEffect(()=>{
    if(!creatingPage||intent||liveSearch.pending||!options?.creationEnabled||!access?.create)return;
    const existing=draftCountCache.current[inactiveDraftBucket];
    if(existing?.scope===draftCountScope&&existing.total!==null)return;
    const abort=new AbortController(),params=new URLSearchParams({page:'1',search:filter.search,bucket:inactiveDraftBucket,view:'count'});
    void digitalRequest<SavedDevelopmentDraftPage>(`sources/drafts?${params}`,'GET',undefined,undefined,{signal:abort.signal})
      .then(value=>{if(!abort.signal.aborted)rememberDraftCount(inactiveDraftBucket,{scope:draftCountScope,total:value.total});})
      .catch(()=>{if(!abort.signal.aborted)rememberDraftCount(inactiveDraftBucket,{scope:draftCountScope,total:null,error:true});});
    return()=>abort.abort();
  },[creatingPage,inactiveDraftBucket,intent,liveSearch.pending,filter.search,draftCountScope,options?.creationEnabled,access?.create,rememberDraftCount]);
  const canCreate=Boolean(options?.creationEnabled&&access?.create);
  const ownLocal=creation.localDrafts.filter(record=>record.identity.actorId===access?.actorId&&(canCreate||record.phase==='pending'));
  const activeDraftList=canCreate&&!liveSearch.pending&&appliedDraftQuery===draftReadKey?drafts:null;
  const draftMatches=draftBucket==='drafts'?activeDraftList:null;
  const countFor=(bucket:DraftBucket)=>{
    const result=draftCounts[bucket];
    return !liveSearch.pending&&result?.scope===draftCountScope?result:null;
  };
  const ordinaryLocalCount=independentLocalDrafts(ownLocal,filter.search).length;
  const tabCount=(bucket:DraftBucket)=>{
    const count=countFor(bucket)?.total;
    return count==null?'—':count+(bucket==='drafts'?ordinaryLocalCount:0);
  };
  const receiptKeys=JSON.stringify(unboundNumberedDraftKeys(ownLocal));
  useEffect(()=>{
    if(!creatingPage||intent||!draftMatches||receiptKeys==='[]')return;
    // Resolve against a list whose read has already finished. A null reply
    // can prove absence for this snapshot only, never for the next page/read.
    const abort=new AbortController();
    void Promise.allSettled((JSON.parse(receiptKeys) as string[]).map(key=>
      digitalRequest<{sourceId:string|null}>('sources/numbered-drafts/receipt','GET',undefined,key,{signal:abort.signal})
        .then(value=>value.sourceId===null?null:DigitalIdSchema.parse(value.sourceId)),
    )).then(replies=>{
      if(abort.signal.aborted)return;
      setDraftReceiptResolution({page:draftMatches,keys:receiptKeys,
        resolvedSourceIds:new Set(replies.flatMap(reply=>reply.status==='fulfilled'&&reply.value?[reply.value]:[])),
        unverified:replies.some(reply=>reply.status==='rejected')});
    });
    return()=>abort.abort();
  },[creatingPage,intent,draftMatches,receiptKeys,access?.actorId]);
  const exactReceipts=draftReceiptResolution?.page===draftMatches&&draftReceiptResolution.keys===receiptKeys?draftReceiptResolution:undefined;
  const draftRows=creatingPage?developmentDraftRows(draftMatches?.items??[],ownLocal,filter.search,draftPage,exactReceipts):[];
  const openSavedDraft=async(sourceId:string)=>{
    if(openingCreation.current)return;
    const location=window.location.href;
    openingCreation.current=true;setCreationBusy(true);setDraftError('');
    try{
      const sheet=await digitalRequest<DevelopmentSheet>(`sources/${sourceId}/development`);
      if(window.location.href!==location)return;
      if(sheet.sourceId!==sourceId||!sheet.canEdit)throw Error('当前没有编辑该草稿的权限');
      if(sheet.status!=='draft'){setRefresh(value=>value+1);throw Error('该草稿已发布，请从开发列表打开原档案');}
      const next=await creation.open(sheet);
      if(next){setDraftLocation(next.viewId);setIntent(next.intent);setConfirm(null);}
    }catch(reason){setDraftError(reason instanceof Error?reason.message:'未能读取该草稿');}
    finally{openingCreation.current=false;setCreationBusy(false);}
  };
  const beginConfirmation=async()=>{
    if(preparing.current||!canConfirm||!editorItem||!editor)return;
    preparing.current=true;setPreparingConfirm(true);setConfirmError("");
    try{
      if(detailLeaveCheck.current&&!await detailLeaveCheck.current())return;
      // Read the selected round again before restoring its published, locked PO draft.
      const currentRound=new URLSearchParams(window.location.search).get("round");
      const current=await digitalRequest<DevelopmentSheet>(`sources/${editor}/development${currentRound?`?round=${encodeURIComponent(currentRound)}`:""}`);
      if(current.productionOrderId||!(current.preorderPublication?options?.workbenchNumberedCreation&&current.canEdit:current.status==='published')){setRefresh(value=>value+1);throw new Error(current.productionOrderId?"此开发单已有客户订单，请核对最新关联订单。":"请先沿原流程发布开发单，再确认客户订单。");}
      setConfirmSheet(current);setConfirm(editorItem);setIntent("confirm_order");
    }catch(reason){setConfirmError(reason instanceof Error?reason.message:"订购资料读取失败，请重试；开发资料仍保留。");}
    finally{preparing.current=false;setPreparingConfirm(false);}
  };
  if(creatingPage&&showCreationView&&options&&!confirm&&['pending','conflict','complete'].includes(creation.mode)){
    const record=creation.restored;
    const showOriginal=Boolean(creation.mayReadSnapshot&&(creation.sourceSheet?.canEdit||record?.phase==='pending'&&!record.sourceId));
    return <Surface className="development-workspace dx-designer-astryx"><style data-designer-style="astryx-v0.7.16">{workspaceAstryxCss}</style>
      <h1>{creation.mode==='pending'?'原创建提交结果待核对':'本页原开发资料保留'}</h1>{showOriginal&&<><p>款号：{record?.snapshot.form.designStyleNo||'未填写'} · 客户：{record?.snapshot.form.customerCode||'未填写'}。完整原输入仍保留，尚未开始新的提交。</p>{record?.snapshot.form.lines.map((line,index)=><p key={index}>原PO {index+1} · {line.formalPoNo||line.poNumber||'未填写'} · {line.color} · {line.sizes.map(size=>`${size.size} ${size.quantity}`).join(' / ')}</p>)}</>}{creation.problem&&<p role="alert">{creation.problem}</p>}{creationMessage&&<p role="status">{creationMessage}</p>}
      {creation.mode==='pending'&&record?.phase==='pending'&&((record.native||isDraftReservationPath(record.original.path)||record.original.method==='PUT')?<DevelopmentEntryAction type="button" disabled={creationBusy} onClick={()=>{setCreationBusy(true);setCreationMessage('');void creation.check().then(result=>{if(result){setIntent(null);void navigateInternalPage(contextUrl({development:result.sourceId,...(record.native?.operation==='publish_preorder'?{section:'workspace'}:{})}));}}).catch(reason=>setCreationMessage(reason instanceof Error?reason.message:'原提交尚未核实，原资料仍保留')).finally(()=>setCreationBusy(false));}}>只读核对原提交结果</DevelopmentEntryAction>:<p>该原创建或保存步骤尚无受支持的只读终态入口；原实际标识及输入保留。不能把它当成新草稿再提交，请先核对权威终态。</p>)}
      <DevelopmentEntryAction type="button" disabled={creationBusy} onClick={()=>{try{creation.close();setDraftLocation();setIntent(null);}catch(reason){setCreationMessage(reason instanceof Error?reason.message:'原恢复记录尚未保留');}}}>返回列表并保留资料</DevelopmentEntryAction>
    </Surface>;
  }
  const creationTypeDialog=<Dialog isOpen={choosingType} onOpenChange={setChoosingType} purpose="form" width="min(440px, calc(100vw - 32px))">
        <DialogHeader title="请选择创建类型" onOpenChange={setChoosingType}/>
        <div className="development-type-choices">
          {DEVELOPMENT_CREATION_TYPES.map(({kind,label,description})=><div key={kind}>
            <AstryxButton label={label} variant={kind===newType?"primary":"secondary"} aria-pressed={kind===newType} isDisabled={creationBusy} onClick={()=>setNewType(kind)}/>
            <p>{description}</p>
          </div>)}
          <Selector label="衣类" placeholder="请选择衣类" isRequired value={newGarment??""} options={DEVELOPMENT_GARMENTS.map(value=>({value,label:value==='上衣'?'上装':'下装'}))}
            isDisabled={creationBusy||!newType} onChange={value=>{if(value==="上衣"||value==="裤子")setNewGarment(value);}}/>
          <Selector label="急单" placeholder="请选择急单" isRequired value={newRush===null?"":newRush?"yes":"no"} options={[{value:"yes",label:"是"},{value:"no",label:"否"}]}
            isDisabled={creationBusy||!newGarment} onChange={value=>{if(value==="yes"||value==="no")setNewRush(value==="yes");}}/>
          <AstryxButton label="进入建单" variant="primary" isDisabled={creationBusy||!newType||!newGarment||newRush===null} onClick={beginCreation}/>
          <AstryxButton label="取消" variant="ghost" isDisabled={creationBusy} onClick={()=>setChoosingType(false)}/>
        </div>
      </Dialog>;
  const creationForm=showCreationView&&displayedIntent&&options?<div className="development-workspace development-golden dx-production-refined development-create-page dx-designer-astryx">
    <style data-designer-style="astryx-v0.7.16">{workspaceAstryxCss}</style>
    {!workbench&&<div className="development-breadcrumb">产品开发 › <strong>{confirm?"客户确定订单":"新建开发订单"}</strong></div>}
    {creatingPage&&!confirm&&!creation.sourceSheet&&!options.workbenchNumberedCreation&&
      <p role="status">自动发号尚未启用，当前使用原建单流程。</p>}
    {creation.problem&&!confirm&&<p role="alert">{creation.problem} <DevelopmentEntryAction type="button" onClick={()=>{try{creation.retry();}catch(reason){setCreationMessage(reason instanceof Error?reason.message:'本页记录仍未保留');}}}>重试保留本页资料</DevelopmentEntryAction></p>}{creationMessage&&<p role="status">{creationMessage}</p>}
    {creatingPage&&!confirm&&creationTypeDialog}
    <DevelopmentCreateForm key={confirm?.journey.id ?? creation.viewId??"new-development"} intent={displayedIntent} guidedCreation={creatingPage&&!confirm} initialPreorder={creation.visibleView?.preorder??false} initialChoices={creation.visibleView?.choices} {...(confirm ? {source: confirm.journey,...(confirmSheet?{existingDraft:confirmSheet}:{}),cancelLabel:"返回开发单"} : {...(creation.sourceSheet?{existingDraft:creation.sourceSheet}:{}),...(creation.viewId&&access?{creation:{viewId:creation.viewId,actorId:access.actorId,snapshot:creation.restored?.snapshot,onSnapshot:creation.snapshot,started:creation.started,acknowledged:creation.acknowledged,refused:creation.refused}}:{})})} contained={workbench} customers={options.customers} independentCraftsEnabled={options.independentCraftsEnabled} orderTimeEnabled={options.orderTimeEnabled} workbenchNumberedCreation={options.workbenchNumberedCreation===true} minimumDate={options.minimumInitialCustomerDate} serverToday={options.serverToday} onIntentChange={setIntent} onChooseCreationType={creatingPage&&!confirm?openCreationChoices:undefined} onCancel={canReturnToServer => {if(!confirm)try{creation.close(canReturnToServer);setDraftLocation();}catch(reason){setCreationMessage(reason instanceof Error?reason.message:'原资料尚未保留');return;}setIntent(null); setConfirm(null); setConfirmSheet(undefined);if(!editor)setRefresh(value => value + 1);}} onCreated={(sourceId,orderId) => {
      if(!confirm)try{if(!creation.completed(sourceId,creation.viewId))return;}catch(reason){setCreationMessage('原办理已完成；本页恢复记录尚未清理。'+(reason instanceof Error?reason.message:''));return;}
      if(confirm&&editor===sourceId){setConfirmedOrderId(orderId);setIntent(null);setConfirm(null);setConfirmSheet(undefined);quietListRefresh.current=true;
        if(workbench)updateEditorFacts();else setRefresh(value=>value+1);}
      else void navigateInternalPage(contextUrl({development:sourceId,section:"workspace"}));
    }}/>
  </div>:null;
  if(creationForm&&!workbench)return creationForm;
  if (editor) {
   const close=()=>{void navigateInternalPage(contextUrl()).then(navigated=>{if(navigated&&!workbench)setRefresh(value=>value+1);});};
   const confirmButton=canConfirm?<Button variant="primary" disabled={preparingConfirm} onClick={()=>void beginConfirmation()}>{preparingConfirm?"正在读取订购资料…":workbench?"客户确认下单":"客户确定订单"}</Button>:null;
   const document=<OrderDocumentContainer key={`${editor}:${round}:${refresh}`} initial={{kind:"development",id:editor,version:round}} onLeaveCheck={rememberLeaveCheck} onDevelopmentRead={rememberOpenedSheet}
    directDevelopmentEdit={workbench} developmentOnly={workbench} headerless={workbench} headerActions={confirmButton} onClose={close}/>;
   return <div className={`development-workspace pattern-orders digital-production${workbench?' dx-designer-astryx':''}`}>
    {workbench&&<style data-designer-style="astryx-v0.7.16">{workspaceAstryxCss}</style>}
    {(error||accessError)&&<p role="alert">开发档案读取失败：{error||accessError} <Button onClick={retryList}>重试读取开发档案</Button></p>}
    {confirmedOrderId&&<><p role="status">客户订单已确认。{confirmedOrder?`已读取关联订单：${confirmedOrder.designStyleNo}。`:!confirmedOrderError?"正在读取关联客户订单…":""} <a href={`${urls.pageUrl("ui/digital-production")}?order=${confirmedOrderId}&returnTo=${encodeURIComponent(window.location.pathname+window.location.search)}`}>查看关联客户订单</a></p>{confirmedOrderError&&<p role="alert">订单确认已成功，关联订单读取失败：{confirmedOrderError} <Button onClick={()=>setOrderRetry(value=>value+1)}>重试读取关联订单</Button></p>}</>}
    {confirmError&&<p role="alert">{confirmError}</p>}
    {workbench?<DesignerOrderWorkbench key={`${editor}:${round??'current'}:${editorSession}`} sourceId={editor} round={round} actorId={access?.actorId} item={editorItem} sheet={editorSheet}
      image={editorItem&&<StyleImage item={editorItem}/>} document={document} confirmation={confirm?creationForm:confirmButton} onClose={close} onChanged={updateEditorFacts}/>:document}
   </div>;
  }
  const unresolved=pendingDevelopmentCommands(ownLocal);
  const discardDraft=async(row:DevelopmentDraftRow)=>{
    const saved=row.kind==='saved'?row.saved:null,local=row.local;
    if(openingCreation.current||!canCreate||local?.phase==='pending'||(saved?!saved.canDiscard:local?.phase!=='draft'))return;
    const session=sessionCacheVersion(),ordered=saved?.designStyleNo??local?.snapshot.form.designStyleNo;
    const approval=saved?.approvalRequestId&&saved.approvalVersion?
      {approvalRequestId:saved.approvalRequestId,approvalVersion:saved.approvalVersion}:undefined;
    if(!await confirmInApp(`确认删除草稿「${ordered?.trim()||'待生成订单ID'}」？${approval?'审批历史将保留。':'原已登记编号不会再次分配。'}`,
      {presentation:'astryx',title:'删除开发草稿',confirmLabel:'删除'}))return;
    if(session!==sessionCacheVersion()||openingCreation.current)return;
    openingCreation.current=true;setCreationBusy(true);setCreationMessage('');
    try{
      if(saved){
        const prior=discardKeys.current.get(saved.sourceId);
        const attempt=prior?.version===saved.version&&prior.approvalRequestId===approval?.approvalRequestId&&prior.approvalVersion===approval?.approvalVersion
          ?prior:{version:saved.version,...approval,key:createClientRequestId()};
        discardKeys.current.set(saved.sourceId,attempt);
        const receipt=await digitalRequest<{discarded?:boolean}>(`sources/${saved.sourceId}/draft`,'DELETE',{expectedVersion:attempt.version,...approval},attempt.key);
        if(receipt?.discarded!==true)throw new DigitalRequestError('删除回执尚未确认',500,'INVALID_RESPONSE');
        if(session!==sessionCacheVersion())return;
        discardKeys.current.delete(saved.sourceId);
        if(access?.actorId)publishTodoRead(access.actorId);
        setRefresh(value=>value+1);
      }
      if(local&&!creation.discardListSnapshot(local)&&!saved)throw Error('本页草稿已变化，请重新核对后删除');
      setCreationMessage('开发草稿已删除。');
    }catch(reason){
      if(session!==sessionCacheVersion())return;
      if(reason instanceof DigitalRequestError&&reason.resultUnknown){setCreationMessage('删除结果待核对，请刷新或重试原草稿删除。');return;}
      if(saved)discardKeys.current.delete(saved.sourceId);
      setCreationMessage(reason instanceof Error?reason.message:'未能删除开发草稿，请刷新并核对。');
    }finally{openingCreation.current=false;setCreationBusy(false);}
  };
  if(creatingPage)return <div className="development-workspace development-golden dx-production-refined dx-designer-astryx">
    <style data-designer-style="astryx-v0.7.16">{workspaceAstryxCss}</style>
    <div className="development-breadcrumb">设计开发工作台 › <strong>创建开发单</strong></div>{creation.problem&&<p role="alert">{creation.problem}</p>}{creationMessage&&<p role="status">{creationMessage}</p>}
    {(canCreate||ownLocal.length>0)&&<section className="dx-production-panel">
      <header><h1>创建开发单</h1></header>
      {creationTypeDialog}
      <div className="development-creation-columns">
      <section className="development-creation-drafts" aria-label="开发草稿箱">
        <h2>开发草稿箱</h2>
        {canCreate&&<div className="development-search-field"><DevelopmentEntryText label="搜索草稿款号" visibleLabel value={search} maxLength={100}
          onCompositionStart={liveSearch.onCompositionStart} onCompositionEnd={liveSearch.onCompositionEnd} onChange={setSearch}
          onKeyDown={event=>{if(event.key==="Enter"&&!event.nativeEvent.isComposing)update({search});}}/></div>}
        {canCreate&&<div className="development-draft-tabs" role="tablist" aria-label="草稿分类">
          <AstryxButton id="development-draft-tab" role="tab" aria-selected={draftBucket==='drafts'} aria-controls="development-draft-panel"
            label={`草稿箱（${tabCount('drafts')}）`} variant={draftBucket==='drafts'?'primary':'secondary'} onClick={()=>setDraftBucket('drafts')}/>
          <AstryxButton id="development-approval-tab" role="tab" aria-selected={draftBucket==='followup'} aria-controls="development-draft-panel"
            label={`待审批-未发布（${tabCount('followup')}）`} variant={draftBucket==='followup'?'primary':'secondary'} onClick={()=>setDraftBucket('followup')}/>
        </div>}
        {canCreate&&countFor(inactiveDraftBucket)?.error&&<p role="alert">草稿计数未能读取
          <DevelopmentEntryAction type="button" onClick={()=>setRefresh(value=>value+1)}>重试计数</DevelopmentEntryAction></p>}
        <div id="development-draft-panel" role={canCreate?'tabpanel':undefined}
          aria-labelledby={canCreate?(draftBucket==='drafts'?'development-draft-tab':'development-approval-tab'):undefined}>
        {canCreate&&(draftError?<p role="alert">{draftError} <DevelopmentEntryAction type="button" onClick={()=>setRefresh(value=>value+1)}>刷新草稿</DevelopmentEntryAction></p>
          :!activeDraftList?<p role="status">正在读取草稿…</p>:draftBucket==='drafts'?draftRows.length===0?<p>暂无开发草稿</p>:null
          :activeDraftList.items.length===0?<p>暂无待审批的未发布草稿</p>:null)}
        {draftBucket==='drafts'?<>
        {draftRows.length>0&&<ul className="development-creation-draft-rows">{draftRows.map(row=>{
          const saved=row.kind==='saved'?row.saved:undefined,local=row.local;
          const kind=local?(local.snapshot.preorder?'预下单':local.snapshot.intent==='development'?'纯开发':'已确认订单'):
            saved?.kind==='preorder'?'预下单':saved?.kind==='development'?'纯开发':saved?.kind==='certain_order'?'已确认订单':null;
          const code=saved?.designStyleNo??saved?.temporaryStyleNo??(local?.snapshot.form.designStyleNo.trim()||'待生成订单ID');
          const label=saved?code:`继续${kind??'开发'}草稿 · ${code}`;
          return <li key={saved?.sourceId??local!.viewId}>
            <div className="development-creation-draft-main">
              <AstryxButton label={label} type="button" variant="ghost" isDisabled={creationBusy} onClick={()=>{
                if(local)void openCreation(()=>creation.resume(local.viewId),local.viewId);
                else if(saved)void openSavedDraft(saved.sourceId);
              }}/>
              <span>{[kind,saved?(`最后保存 ${date(saved.updatedAt)}`):'尚未写入服务器',!saved?.designStyleNo?'尚未发号':null].filter(Boolean).join(' · ')}</span>
            </div>
            {canCreate&&(!saved||saved.canDiscard)&&<AstryxButton label="删除" aria-label={`删除草稿 ${code}`} variant="destructive" size="sm" type="button" isDisabled={creationBusy} onClick={()=>void discardDraft(row)}/>}
          </li>;
        })}</ul>}
        </>:activeDraftList?.items.length?<div className="development-draft-approval-scroll"><table className="development-draft-approval-table">
          <thead><tr><th scope="col">款号</th><th scope="col">时效状态</th><th scope="col">最近更新</th><th scope="col">操作</th></tr></thead>
          <tbody>{activeDraftList.items.map(saved=>{
            const code=saved.designStyleNo??saved.temporaryStyleNo??'原开发档案';
            const status=saved.approvalState?draftApproval[saved.approvalState]:null;
            const pending=unresolved.some(record=>record.sourceId===saved.sourceId||
              !record.sourceId&&record.snapshot.form.designStyleNo.trim()!==''&&record.snapshot.form.designStyleNo.trim()===saved.designStyleNo);
            const local=ownLocal.find(record=>record.phase==='bound'&&record.sourceId===saved.sourceId);
            return <tr key={saved.sourceId}><th scope="row">{code}</th>
              <td>{status&&<StatusBadge tone={status.tone}>{status.label}</StatusBadge>}
                {saved.approvalState==='returned'&&saved.approvalReturnReason?.trim()&&<p className="development-draft-return-reason">{saved.approvalReturnReason}</p>}</td>
              <td><time dateTime={saved.updatedAt}>{new Date(saved.updatedAt).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'})}</time></td>
              <td><div className="development-draft-row-actions">
                {!pending&&saved.approvalState!=='pending'&&<AstryxButton label="继续编辑" aria-label={`继续编辑草稿 ${code}`} variant="secondary" size="sm"
                  isDisabled={creationBusy} onClick={()=>void openSavedDraft(saved.sourceId)}/>}
                {!pending&&saved.canDiscard&&<AstryxButton label="删除" aria-label={`删除草稿 ${code}`} variant="destructive" size="sm"
                  isDisabled={creationBusy} onClick={()=>void discardDraft({kind:'saved',saved,...(local?{local}:{})})}/>}
              </div></td>
            </tr>;
          })}</tbody>
        </table></div>:null}
        {canCreate&&activeDraftList&&<ListPagination page={activeDraftList.page} totalPages={Math.max(1,Math.ceil(activeDraftList.total/15))}
          total={activeDraftList.total} busy={creationBusy||liveSearch.pending} onPageChange={setActiveDraftPage}
          ariaLabel={draftBucket==='drafts'?'开发草稿分页':'待审批草稿分页'}/>}
        </div>
      </section>
      {canCreate&&<section className="development-creation-entry" aria-label="新建开发订单入口">
        <h2>新建开发订单</h2>
        <p>选择订单类型后填写开发资料。</p>
        <AstryxButton label="新建开发订单" variant="primary" isDisabled={creationBusy} onClick={openCreationChoices}/>
      </section>}
      </div>
      {unresolved.length>0&&<section className="development-creation-followup" aria-label="原提交结果待核对">
        <h2>原提交结果待核对</h2>
        <ul className="development-creation-draft-rows">{unresolved.map(record=><li key={record.viewId}>
          <span>{record.snapshot.form.designStyleNo.trim()||'原创建资料'}</span>
          <DevelopmentEntryAction type="button" disabled={creationBusy} onClick={()=>void openCreation(()=>creation.resume(record.viewId),record.viewId)}>核对原创建提交结果</DevelopmentEntryAction>
        </li>)}</ul>
      </section>}
    </section>}
    {accessError&&<p role="alert">{accessError}</p>}
    {access&&(!access.create||options?.creationEnabled===false)&&<p role="status">当前身份或环境未开放开发单创建。</p>}
  </div>;
  return <div className="development-workspace development-golden dx-production-refined dx-designer-astryx">
    <style data-designer-style="astryx-v0.7.16">{workspaceAstryxCss}</style>
    <div className="development-breadcrumb">设计开发工作台 › <strong>开发工作区</strong></div>
    <section className="dx-production-panel development-list-panel">

      <FilterBar as="div"><label className="development-search-field">款号 / PO<input value={search} maxLength={100} onCompositionStart={liveSearch.onCompositionStart} onCompositionEnd={liveSearch.onCompositionEnd} placeholder="款号、款名或 PO" onChange={event => setSearch(event.target.value)} onKeyDown={event => {if (event.key === "Enter"&&!event.nativeEvent.isComposing) update({search});}}/></label><label>客户<SearchableSelect value={filter.customer ?? ""} onChange={event => update({customer:event.target.value || undefined})}><option value="">全部客户</option>{result?.customers.map(customer => <option key={customer}>{customer}</option>)}</SearchableSelect></label><label>设计师<SearchableSelect value={filter.designer ?? ""} onChange={event => update({designer:event.target.value || undefined})}><option value="">全部设计师</option>{result?.designers?.map(designer => <option key={designer}>{designer}</option>)}</SearchableSelect></label><label>订单状态<select value={filter.businessView??''} onChange={event=>update({view:'all',
          businessView:(event.target.value||undefined) as DevelopmentWorkspaceFilter['businessView']})}>
          <option value="">全部订单</option>{DESIGNER_BUSINESS_VIEWS.map(view=><option key={view.key} value={view.key}>{view.label}</option>)}</select></label><label className="development-date-field">创建日期<span className="development-date-input"><input aria-label="创建开始日期" type="date" value={filter.startDate ?? ""} onChange={event => update({startDate:event.target.value || undefined})}/><span aria-hidden="true">{filter.startDate ?? "开始日期"}</span></span><span className="development-date-separator">至</span><span className="development-date-input"><input aria-label="创建结束日期" type="date" value={filter.endDate ?? ""} onChange={event => update({endDate:event.target.value || undefined})}/><span aria-hidden="true">{filter.endDate ?? "结束日期"}</span></span></label></FilterBar>
      {(error||accessError) && <p role="alert">{error||accessError}</p>}{result?.freshness&&<p role="status">本页有部分明细未能读取。 <Button onClick={retryList}>重新读取</Button></p>}{result?.detailFailures?.length? <p role="status">{result.detailFailures.map(item=>item.designStyleNo).join("、")} 的详情读取失败。<Button onClick={retryList}>重新读取本页</Button></p>:null}
      <>
      <div className="development-view-cards">{DESIGNER_BUSINESS_VIEWS.map((view,index)=><KpiCard key={view.key}
       icon={<NavigationIcon name={(["FileText","History","Users","PackageCheck"] as const)[index]??"FileText"}/>}
       className={`development-kpi development-kpi-${index}`} label={view.label}
       value={appliedListQuery===listQuery&&!liveSearch.pending?(result?.businessCounts?.[view.key]??'—'):'—'}
       detail={['已实际发布开发','已发布待正式确认','已确认正式母单','电子资料与样衣均已交接'][index]}
       selected={filter.businessView===view.key}
       onClick={()=>update({view:'all',businessView:filter.businessView===view.key?undefined:view.key})}/>)}</div>
      <div className="development-table-scroll development-list-viewport" role="region" aria-label="开发工作区列表，可横向查看全部列" tabIndex={0}>
        <BusinessTable>
          <thead><tr><th>序号</th><th>款图 / 款号</th><th>款式（品名）</th><th>客户</th><th>设计师</th><th>订单ID</th><th>订单类型</th><th>当前轮次</th><th>当前待办理 / 状态</th><th>样衣寄出</th><th>要求完成</th><th>创建日期</th></tr></thead>
          <tbody>{result?.items.map((item,index)=>{
            const href=item.journey.sourceId?openUrl(item):null;
            const shipping=item.business?.shipping;
            const title=<><StyleImage key={`${item.journey.id}:${item.journey.sourceVersion}:${item.journey.selectedRound}:${item.journey.styleImageUrl}`} item={item}/><strong>{item.journey.designStyleNo}</strong><OrderRushBadge value={item.orderRush}/></>;
            return <tr key={item.journey.id} className={selectedId===item.journey.id?'is-selected':''} onClick={event=>{
              const target=event.target;
              if(event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey
                ||!(target instanceof Element)||target.closest('a,button,input,select,textarea,label,summary,[role="button"],[role="link"],[contenteditable]')
                ||window.getSelection()?.toString())return;
              if(href)void navigateInternalPage(href);
              else select(item.journey.id);
            }}>
              <td>{((result?.page??filter.page)-1)*15+index+1}</td>
              <td>{href?<Link type="inherit" className="development-row-select" id={`development-open-${item.journey.id}`} href={href}>{title}</Link>
                :<button className="development-row-select development-text-action" type="button" onClick={()=>select(item.journey.id)}>{title}</button>}</td>
              <td>{item.journey.styleName??"未登记"}</td><td>{item.journey.customer??"通用开发"}</td>
              <td>{item.journey.designer??'未登记'}</td><td>{item.journey.identity?.businessNumber??'未登记'}</td>
              <td>{item.business?DESIGNER_BUSINESS_VIEWS.find(view=>view.key===item.business!.kind)?.label:'待核对'}
               {item.journey.developmentType&&<small>{item.journey.developmentType}</small>}</td>
              <td>{item.journey.sourceVersion?`第 ${item.journey.selectedRound??1} 轮`:"待填写"}</td>
              <td><StatusBadge tone={item.view==='ordered'?'success':item.view==='draft'?'neutral':'info'}>{item.business?.handoverComplete?'已交接完成':viewLabel(item)}</StatusBadge>
                {Boolean(item.handling?.items.length)&&<DesignerHandlingItems key={`${item.journey.id}:${appliedListQuery}`} handling={item.handling!} limit={1}
                  hrefFor={target=>digitalChildDetailHref(target,contextUrl({},filter,item.journey.id),urls.base)}/>}
              </td>
              <td><StatusBadge tone={developmentShippingTone(shipping?.state??'unknown')}>{developmentShippingLabel[shipping?.state??'unknown']}</StatusBadge>
               {shipping?.state==='sent'&&<small><time dateTime={shipping.sentDate}>{date(shipping.sentDate)}</time><span>{shipping.trackingNo}</span></small>}</td>
              <td>{date(item.journey.requiredCompletionDate)}</td><td>{date(item.journey.createdAt)}</td>
            </tr>;
          })}</tbody>
        </BusinessTable>
      {result && !result.freshness && !result.detailFailures?.length && !result.items.length && <p className="development-empty">当前视图暂无档案</p>}{!result && !error && <p role="status">正在读取开发档案…</p>}</div>
      {!result?.freshness&&<Pagination page={filter.page} pageSize={15} total={!liveSearch.pending&&appliedListQuery===listQuery?result?.total??null:null} onPage={page => update({page})}/>}
      </>
    </section>
    {!intent && selected && <section className="dx-production-panel development-selected" aria-label="选中开发档案">
      {!selected ? <p className="development-empty">从上方列表选择档案，查看开发资料与订购信息。</p> : <>
        <header className="development-selected-heading"><StyleImage key={`${selected.journey.id}:${selected.journey.sourceVersion}:${selected.journey.styleImageUrl}`} item={selected}/><div><h2>{selected.journey.designStyleNo} <StatusBadge tone="info">{viewLabel(selected)}</StatusBadge></h2><p>款名：{selected.journey.styleName ?? "未登记"} · 客户：{selected.journey.customer ?? "通用开发"} · 开发类型：{sheet?.developmentType ?? "未读取"} · 设计师：{selected.journey.designer ?? "未登记"} · 创建日期：{date(selected.journey.createdAt)}</p></div><button className="development-text-action" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>{collapsed ? "展开" : "收起"}</button></header>
        {!collapsed&&<DevelopmentOrderArchive item={selected} sheet={sheet} order={orders[selected.journey.id]} sheetError={sheetErrors[selected.journey.id]} orderError={orderErrors[selected.journey.id]} sourceUrl={selected.journey.sourceId?openUrl(selected):null}/> }
      </>}
    </section>}
  </div>;
}
