// Actual navigation/document/reporting owners, with synthetic local TEST reads only.
import '../../apps/web/src/App.js';
import {createRoot} from 'react-dom/client';
import {useEffect,useRef,useState} from 'react';
import {installInternalNavigation,navigateInternalPage} from '../../apps/web/src/internal-navigation.js';
import {useDigitalDetailNavigationGuard} from '../../apps/web/src/use-digital-detail-navigation-guard.js';
import {OrderDocumentContainer} from '../../apps/web/src/order-document-container.js';
import {digitalDetailClosePath,digitalDetailRoute} from '../../apps/web/src/digital-detail-route.js';
import {ProductionReportingPage} from '../../apps/web/src/production-reporting-page.js';
import {invalidateSession} from '../../apps/web/src/auth-session.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {BudgetDocumentSchema,calculateBudget} from '@dx-rework/contracts/digital-budget';
import '@dx-rework/ui/tokens.css';import '@dx-rework/ui/components.css';import '../../apps/web/src/styles.css';
import '../../apps/web/src/workflow-shell.css';import '../../apps/web/src/ui-polish.css';
const options=(window as unknown as {pr5Options:{mode:string;na?:boolean}}).pr5Options;
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,sourceId=id(101),orderId=id(100),now='2026-10-27T09:00:00.000Z';
const requests:Array<{path:string;method:string;key:string|null;body:unknown;actor:string}>=[],holds=new Map<string,(()=>void)[]>(),blocked=new Set<string>(),receipts=new Map<string,unknown>();
let actor=id(1),role='root',lost=false,commits=0,wrong=false;
const detail=(productionOrderId:string,factoryDecisionId:string|null=null,reader=actor)=>({order:{productionOrderId,sourcingCaseId:id(41),factoryDecisionId,firstStyleNo:`TEST-${productionOrderId.slice(-3)}-${factoryDecisionId?.slice(-3)??'original'}-${reader.slice(-3)}`,status:'in_production',dispatchedAt:now,dispatchedBy:id(1),sourceCaseArchived:false,decisionVersion:1,sourcingContractDocumentId:id(42),contractNumber:'TEST-CONTRACT',contractVersion:1,supplierId:id(43),supplierName:'TEST工厂',gender:'女装',styleName:'TEST款式',quantity:10,completedQuantity:0,processes:[],deliveryDate:null,firstReportedOn:null,reportingState:'pending_first_report',timeProgress:null,progressAlert:null,lines:[{position:1,styleNo:'TEST款式',alternateStyleNo:null,color:'TEST蓝',quantity:10,completedQuantity:0}]},canReport:role==='root',canCorrect:role==='root',history:[],transitions:[],shipment:null,businessToday:'2026-10-27',asOf:now});
const development={sourceId,productionOrderId:options.na?null:orderId,designStyleNo:'TEST开发来源',temporaryStyleNo:null,customerCode:null,developmentType:'头版',designerName:'TEST设计师',version:2,status:'published',document:initialDevelopmentDocument(),publishedAt:now,taskId:null,canEdit:false,materialEvents:[],roundNumber:2,latestRoundNumber:2};
const budgetDocument=BudgetDocumentSchema.parse({fabricType:'梭织',productCategory:'TEST',monthSeries:'TEST',date:'2026-10-27',currency:'人民币',rows:[],freight:'1',cm:'2',salePrice:'10',outsourcingScope:'TEST',outsourcingUnitPrice:'3',imageAttachmentIds:[]});
const fixture={requests,hold:(path:string)=>blocked.add(path),release:(path:string)=>{blocked.delete(path);for(const release of holds.get(path)??[])release();holds.delete(path);},loseNext:()=>{lost=true;},wrongEntity:()=>{wrong=true;},changeIdentity:(next:string,nextRole='root')=>{actor=next;role=nextRole;invalidateSession();},get commits(){return commits;},navigate:(path:string)=>navigateInternalPage(path)};
Object.assign(window,{pr5Fixture:fixture});
window.fetch=async(input,init)=>{
 const url=new URL(String(input),location.origin),path=url.pathname+url.search,method=init?.method??'GET',key=new Headers(init?.headers).get('idempotency-key'),body=init?.body?JSON.parse(String(init.body)):null,reader=actor;
 requests.push({path,method,key,body,actor:reader});
 const response=(value:unknown,status=200)=>Response.json(value,{status,headers:{'x-dx-rework-actor-id':reader}});
 if(url.pathname.endsWith('/auth/me'))return response({status:'authorized',user:{id:actor,displayName:'TEST '+actor.slice(-3),isRoot:role==='root',businessRoles:role==='root'?['root_superuser']:[],capabilities:role==='root'?['sourcing:view','production-reporting']:[],effectiveWriteCapabilities:role==='root'?undefined:[]}});
 if(path.includes('/notifications/'))return response({notification:null,remainingCount:0});
 if(path.includes('/indicator'))return response({pendingCount:0,unreadCount:0});
 const holdKey=blocked.has(method+':'+path)?method+':'+path:path;
 if(blocked.has(holdKey))await new Promise<void>(resolve=>{const pending=holds.get(holdKey)??[];pending.push(resolve);holds.set(holdKey,pending);});
 if(url.pathname==='/api/production-reporting/scopes')return response(method==='POST'?{saved:true}:{users:[{userId:id(1),displayName:'TEST驻厂'}],suppliers:[{supplierId:id(43),supplierName:'TEST工厂'}],scopes:[]});
 if(url.pathname==='/api/production-reporting')return response({items:[],page:1,pageSize:15,totalCount:0,suppliers:[]});
 const production=url.pathname.match(/^\/api\/production-reporting\/([0-9a-f-]+)(\/.*)?$/);
 if(production){const value=detail(wrong?id(40):production[1]!,url.searchParams.get('factoryDecisionId')??body?.factoryDecisionId??null,reader);
  if(method==='POST'){const receiptKey=path+':'+key;if(receipts.has(receiptKey))return response(receipts.get(receiptKey));commits++;receipts.set(receiptKey,value);if(lost){lost=false;throw new TypeError('TEST receipt lost after commit');}}
  return response(value);
 }
 if(path.includes('/document-directory/'))return response({development:{state:'available',id:sourceId,version:2},budget:options.na?{state:'not_applicable'}:{state:'available',id:orderId,version:3},instruction:{state:'not_applicable'}});
 if(path.includes('/development/rounds'))return response({rounds:[],draft:null});
 if(url.pathname.endsWith('/development'))return response(development);
 if(url.pathname.endsWith('/execution'))return response({tasks:[],facts:[],routeFacts:[],patternOrder:null});
 if(url.pathname.endsWith('/budget'))return response({productionOrderId:orderId,version:3,status:'published',document:budgetDocument,totals:calculateBudget(budgetDocument),canEdit:false,canSubmitSourcing:false,sourcingCaseId:null,publishedAt:now,versions:[3]});
 if(url.pathname.endsWith('/orders/'+orderId))return response({productionOrderId:orderId,designStyleNo:'TEST真实母单',customerCode:'TEST',productGroup:'男装',lines:[]});
 return response({error:{message:'TEST unconnected read '+path}},404);
};
function Editor(){const [draft,setDraft]=useState(''),writing=useRef(false);useDigitalDetailNavigationGuard(Boolean(draft),false,writing,'TEST未保存修改');return <><label>TEST草稿<input value={draft} onChange={e=>setDraft(e.target.value)}/></label><button onClick={()=>{const url=new URL(location.href);url.searchParams.set('documentChapter','development-handling');url.searchParams.set('documentCategory','results');url.hash='TEST-anchor';history.replaceState(history.state,'',url);}}>TEST切换章节</button><a href="/ui/my-tasks">TEST离开编辑</a></>;}
function Fixture(){const [href,setHref]=useState(location.href);useEffect(()=>installInternalNavigation('',()=>setHref(location.href)),[]);
 if(options.mode==='nav')return location.pathname==='/ui/my-tasks'?<a href={`/ui/digital-production?development=${sourceId}&round=2&returnTo=${encodeURIComponent('/ui/my-tasks?q=TEST&page=3')}`}>TEST打开编辑</a>:<Editor/>;
 if(options.mode==='report')return new URL(href).pathname.startsWith('/ui/production-reporting')?<ProductionReportingPage productionOrderId={new URL(href).pathname.split('/')[3]}/>:<p>TEST其他页面</p>;
 const route=digitalDetailRoute(new URL(href).search);
 return <OrderDocumentContainer initial={route.kind==='development'||route.kind==='budget'||route.kind==='instruction'?{kind:route.kind,id:route.id,version:route.version}:{kind:'development',id:sourceId,version:2}} onClose={()=>{const back=digitalDetailClosePath(location.search,'/');if(back)void navigateInternalPage(back);}}/>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
