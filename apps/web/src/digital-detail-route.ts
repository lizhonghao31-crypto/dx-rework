import {PatternHistoryQuerySchema} from '@dx-rework/contracts/pattern-orders';
import {patternHistoryPath} from './pattern-history-query.js';
import { DigitalIdSchema, type DigitalOrder, type DigitalSource } from "@dx-rework/contracts/digital-production";
import type { AuthorizedUser } from "./auth.js";
import type { DigitalAccessOptions } from "./digital-production-access-panel.js";
import { canAccessDigitalProduction } from "./platform-modules.js";
import { cockpitReturnPath } from "./digital-journey-cockpit-model.js";
import { developmentWorkspaceReturnUrl } from "./development-workspace-return.js";
import { readTodoQuery, todoQueryPath } from "./todo-query-state.js";
import { createWebUrls } from "../url-contract.js";
import {documentCategories,documentChapterIds,documentVersionKeys,isCurrentDocumentVersion,readDocumentKind,readDocumentVersion,taskTabLabels} from './digital-detail-context.js';
import {factoryTaskTarget} from './factory-task-target.js';
import {readTechnicalOriginalSearch,technicalOriginalKeys} from './technical-original-route.js';

const domains = ["timeRequest", "timeOrder", "timeSource", "closure", "factory", "bulk", "materialSource", "materialOrder", "instruction", "budget", "quotationSource", "quotationOrder", "arrangement", "development", "task", "order", "shortLead"] as const;
type Domain = typeof domains[number];
const versions: Partial<Record<Domain, string>> = { timeRequest:'requestVersion',instruction: "instructionVersion", budget: "budgetVersion", development: "round", arrangement: "round",quotationSource:'quoteVersion',quotationOrder:'quoteVersion' };
export type DigitalDetailRoute = { kind: "landing" } | { kind: "invalid"; message: string } | { kind: Domain; id: string; version?: number; documentVersion?:number;original?:boolean;quoteId?:string };

/** Preserve compound-link priority; malformed history never opens current editable data. */
export function digitalDetailRoute(search: string): DigitalDetailRoute {
  const query = new URLSearchParams(search);
  for (const kind of domains) {
    if (!query.has(kind)) continue;
    const id = query.get(kind);
    if (query.getAll(kind).length !== 1 || !DigitalIdSchema.safeParse(id).success) return { kind: "invalid", message: "详情编号无效，请从原工作台重新进入" };
    const versionKey = versions[kind], raw = versionKey ? query.get(versionKey) : null;
    if (raw !== null && (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || query.getAll(versionKey!).length !== 1)) return { kind: "invalid", message: "历史版本或轮次无效，请从原记录重新进入" };
    const original=query.get('originalDocument'),quotation=kind==='quotationSource'||kind==='quotationOrder',quoteId=query.get('quoteId');
    if(query.has('quoteId')&&!quotation||query.has('originalDocument')&&(query.getAll('originalDocument').length!==1||!['budget','instruction'].includes(kind)||original!==kind||raw===null)||quotation&&(raw===null||query.getAll('quoteId').length!==1||!DigitalIdSchema.safeParse(quoteId).success))return {kind:'invalid',message:'原单对象或精确版本无效，未打开当前资料'};
    const documentVersion=query.get('developmentDocumentVersion');
    if(query.has('developmentDocumentVersion')&&(kind!=='development'||raw===null||query.getAll('developmentDocumentVersion').length!==1||!documentVersion||!/^[1-9]\d*$/.test(documentVersion)||!Number.isSafeInteger(Number(documentVersion))))return {kind:'invalid',message:'开发原单轮次或资料版本无效，请从原记录重新进入'};
    if (kind === "task" && query.has("taskView") && (query.getAll("taskView").length !== 1 || !["read", "handle", "correct"].includes(query.get("taskView")!))) return { kind: "invalid", message: "任务查看方式无效，请从原待办重新进入" };
    return { kind, id: id!, ...(raw === null ? {} : { version: Number(raw) }),...(documentVersion===null?{}:{documentVersion:Number(documentVersion)}),...(original?{original:true}:{}),...(quotation?{quoteId:quoteId!}:{}) };
  }
  if(query.has('developmentDocumentVersion')||query.has('originalDocument')||query.has('quoteId'))return {kind:'invalid',message:'缺少原单编号，未打开当前版本'};
  return { kind: "landing" };
}

export function digitalLandingPath(user: AuthorizedUser): string | null {
  if (!canAccessDigitalProduction(user)) return null;
  return !user.isRoot && user.businessRoles?.includes("sample_designer") && user.capabilities.includes("pattern_room:orders:create")
    ? "ui/digital-production?workspace=designer" : "ui/digital-cockpit";
}

function localUrl(value: string | null): URL | null {
  if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  try {
    const url = new URL(value, "https://local.invalid");
    return url.origin === "https://local.invalid" && !url.hash && [...url.searchParams.keys()].length === new Set(url.searchParams.keys()).size ? url : null;
  } catch { return null; }
}

function workbenchReturn(value: string | null, base: string): string | null {
  const url = localUrl(value);
  if (!url) return null;
  const urls = createWebUrls(base);
  if (["/ui/digital-cockpit", urls.pageUrl("ui/digital-cockpit")].includes(url.pathname)) {
    if(['pattern','preparation'].includes(url.searchParams.get('workspace')??'')){
      const alias=new URL(url);alias.pathname=urls.pageUrl('ui/digital-pattern-room');alias.searchParams.delete('workspace');
      if(developmentWorkspaceReturnUrl(alias.pathname+alias.search,base))return urls.pageUrl('ui/digital-cockpit')+url.search;
    }
    const target = cockpitReturnPath(`?returnTo=${encodeURIComponent("/ui/digital-cockpit?" + url.searchParams)}`);
    return target ? urls.pageUrl(target) : null;
  }
  if(['/ui/pattern-room/history',urls.pageUrl('ui/pattern-room/history')].includes(url.pathname)){
    if([...url.searchParams.keys()].some(key=>!['q','source','status','creatorId','workerId','page'].includes(key)))return null;
    const parsed=PatternHistoryQuerySchema.safeParse(Object.fromEntries(url.searchParams));return parsed.success?urls.pageUrl(patternHistoryPath(parsed.data)):null;
  }
  const localWorkspace=url.pathname.startsWith('/ui/')?urls.pageUrl(url.pathname)+url.search:value;
  const workspace = developmentWorkspaceReturnUrl(localWorkspace, base);
  if (workspace) return workspace;
  if (["/ui/my-tasks", urls.pageUrl("ui/my-tasks")].includes(url.pathname) && [...url.searchParams.keys()].every(key => ["q", "module", "page"].includes(key))) return urls.pageUrl(todoQueryPath(readTodoQuery(url.search)));
  return null;
}

/** Native task -> domain -> exact task -> original filtered todo/workbench. */
export function digitalDetailReturnUrl(value: string | null, base: string,depth=0,visited:readonly string[]=[]): string | null {
  if(depth>3)return null;
  const direct = workbenchReturn(value, base);
  if (direct) return direct;
  const url = localUrl(value), urls = createWebUrls(base);
  if (!url || !["/ui/digital-production", urls.pageUrl("ui/digital-production")].includes(url.pathname)) return null;
  const query=url.searchParams,present=domains.filter(kind=>query.has(kind)),active=digitalDetailRoute(url.search);
  if(active.kind==='landing'||active.kind==='invalid'||present.some(kind=>!DigitalIdSchema.safeParse(query.get(kind)).success))return null;
  const kind=active.kind,hasTask=present.includes('task');
  const originalTechnical=kind==='development'?readTechnicalOriginalSearch(url.search):undefined;
  if(originalTechnical===null||originalTechnical&&(present.length!==1||active.documentVersion!==undefined))return null;
  const identity=`${kind}:${active.id}:${active.version??(kind==='task'?query.get('taskView')??'handle':'current')}${active.documentVersion===undefined?'':':document:'+active.documentVersion}${originalTechnical?':technical:'+originalTechnical.id+':'+originalTechnical.version:''}`;
  if(visited.includes(identity))return null;
  const presentVersionKeys=present.flatMap(domain=>versions[domain]?[versions[domain]!]:[]);
  if(presentVersionKeys.some(key=>query.has(key)&&(!/^[1-9]\d*$/.test(query.get(key)!)||!Number.isSafeInteger(Number(query.get(key))))))return null;
  const documentContext=hasTask||present.some(domain=>['development','budget','instruction'].includes(domain))&&readDocumentKind(url.search)!==undefined;
  if(![...query.keys()].every(key=>[...present,...presentVersionKeys,...(documentContext?Object.values(documentVersionKeys):[]),...(kind==='development'?['developmentDocumentVersion']:[]),...(originalTechnical?technicalOriginalKeys:[]),...(['budget','instruction'].includes(kind)?['originalDocument']:[]),...(['quotationSource','quotationOrder'].includes(kind)?['quoteId']:[]),'taskView','todo','returnTo','workbench','taskTab','documentCategory','documentChapter','documentKind','line','factoryAction','washingWindow'].includes(key)))return null;
  if(documentContext&&Object.entries(documentVersionKeys).some(([document,key])=>query.has(key)&&readDocumentVersion(document as keyof typeof documentVersionKeys,url.search)===undefined&&!isCurrentDocumentVersion(document as keyof typeof documentVersionKeys,url.search)))return null;
  if(query.has('documentKind')&&!readDocumentKind(url.search))return null;
  if (query.has("taskView") && (!hasTask || !["read", "handle", "correct"].includes(query.get("taskView")!))) return null;
  if (query.has("todo") && !DigitalIdSchema.safeParse(query.get("todo")).success) return null;
  if(query.has('workbench')&&(!hasTask||query.get('workbench')!=='sample'))return null;
  if(query.has('taskTab')&&(!hasTask||!Object.hasOwn(taskTabLabels,query.get('taskTab')!)))return null;
  if(query.has('documentCategory')&&!(documentCategories as readonly string[]).includes(query.get('documentCategory')!))return null;
  if(query.has('documentChapter')&&!(documentChapterIds as readonly string[]).includes(query.get('documentChapter')!))return null;
  if(query.has('line')&&(!present.some(domain=>['bulk','factory','order'].includes(domain))||!DigitalIdSchema.safeParse(query.get('line')).success))return null;
  if(query.has('factoryAction')&&(!present.includes('factory')||factoryTaskTarget(url.search).error))return null;
  if(query.has('washingWindow')&&(!present.includes('factory')||factoryTaskTarget(url.search).error))return null;
  const nested = query.has("returnTo") ? digitalDetailReturnUrl(query.get("returnTo"), base,depth+1,[...visited,identity]) : null;
  if (query.has("returnTo") && !nested) return null;
  if(kind==='task'&&query.get('taskView')!=='read'&&nested&&new URL(nested,'https://local.invalid').searchParams.has('task'))return null;
  if (nested) query.set("returnTo", nested);
  return urls.pageUrl("ui/digital-production") + "?" + query;
}

export function digitalChildDetailHref(target:string,source:string|null,base:string):string{
  const url=localUrl(target),urls=createWebUrls(base);
  if(!url)return '';
  const prefix=urls.base==='/'?'':urls.base.slice(0,-1),path=prefix&&url.pathname.startsWith(prefix+'/')?url.pathname.slice(prefix.length):url.pathname;
  if(!path.startsWith('/ui/'))return '';
  const back=digitalDetailReturnUrl(source,base);
  if(back)url.searchParams.set('returnTo',back);
  return urls.pageUrl(path)+url.search;
}

/** Carry the exact current detail, or a validated original workspace, through a second hop. */
export function productionWorkspaceDomainHref(target:string,search:string,base=import.meta.env.BASE_URL,pathname=typeof window==='undefined'?createWebUrls(base).pageUrl('ui/digital-production'):window.location.pathname):string{
  const query=new URLSearchParams(search),current=digitalDetailReturnUrl(pathname+(query.size?'?'+query:''),base);
  const back=current??(query.getAll('returnTo').length===1?digitalDetailReturnUrl(query.get('returnTo'),base):null);
  return digitalChildDetailHref(target,back,base);
}

export function bulkCuttingDetailHref(target:string,orderId:string,lineId:string,search:string,base=import.meta.env.BASE_URL,pathname=typeof window==='undefined'?createWebUrls(base).pageUrl('ui/digital-production'):window.location.pathname):string{
  const urls=createWebUrls(base),currentQuery=new URLSearchParams(search);
  const current=digitalDetailReturnUrl(pathname+(currentQuery.size?'?'+currentQuery:''),base);
  const parent=new URL(urls.pageUrl('ui/digital-production'),'https://local.invalid');
  parent.searchParams.set('bulk',orderId);parent.searchParams.set('line',lineId);
  const existing=current?new URL(current,'https://local.invalid'):null;
  const back=existing?.searchParams.get('bulk')===orderId?existing.searchParams.get('returnTo'):current??(currentQuery.getAll('returnTo').length===1?digitalDetailReturnUrl(currentQuery.get('returnTo'),base):null);
  if(back)parent.searchParams.set('returnTo',back);
  return digitalChildDetailHref(target,parent.pathname+parent.search,base);
}

export function digitalDetailClosePath(search: string, base: string): string | null {
  const query = new URLSearchParams(search);
  const explicit = query.getAll("returnTo").length === 1 ? digitalDetailReturnUrl(query.get("returnTo"), base) : null;
  if (explicit) return explicit;
  const route = digitalDetailRoute(search);
  if (route.kind === "landing" || route.kind === "invalid") return null;
  query.delete(route.kind);
  if (versions[route.kind]) query.delete(versions[route.kind]!);
  if(route.kind==='development')query.delete('developmentDocumentVersion');
  if(['quotationSource','quotationOrder'].includes(route.kind))query.delete('quoteId');
  if(['budget','instruction'].includes(route.kind))query.delete('originalDocument');
  if (route.kind === "task") { query.delete("taskView"); query.delete("todo"); }
  query.delete("returnTo");
  const remaining = digitalDetailRoute(query.toString());
  return remaining.kind !== "landing" && remaining.kind !== "invalid" ? createWebUrls(base).pageUrl("ui/digital-production") + "?" + query : null;
}

export function canAttachHistoricalSource(order: DigitalOrder, access: DigitalAccessOptions): boolean {
  return !order.sourceId && (access.manage || access.roles.includes("sample_designer") && order.createdBy === access.actorId);
}
export function historicalSourceCandidates(order: DigitalOrder, sources: DigitalSource[]): DigitalSource[] {
  return sources.filter(source => !source.productionOrderId && source.createdBy === order.createdBy && source.designStyleNo === order.designStyleNo && (source.temporaryStyleNo ?? "") === (order.temporaryStyleNo ?? "") && (!source.customerCode || source.customerCode === order.customerCode));
}
