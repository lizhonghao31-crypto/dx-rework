// Real existing order detail and local planning components; all HTTP data below is synthetic.
import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {JOURNEY_STAGES,type OrderJourney,type JourneyNode} from '@dx-rework/contracts/digital-production-journey';
import type {SeriesPlanState,SeriesPlanSnapshot,SeriesPlanPreview,SeriesPreviewInput} from '@dx-rework/contracts/digital-series-plan';
import {seriesMilestones,retainSeriesTargets} from '@dx-rework/domain/series-plan';
import {CockpitDetail} from '../../apps/web/src/cockpit-detail.js';
import {SeriesSettings} from '../../apps/web/src/series-settings.js';
import {canLeaveInternalPage} from '../../apps/web/src/internal-navigation.js';
import type {CockpitContext} from '../../apps/web/src/digital-journey-cockpit-model.js';
import '@dx-rework/ui/tokens.css';import '@dx-rework/ui/components.css';
import '../../packages/ui/src/production.css';import '../../apps/web/src/digital-journey-cockpit.css';
import '../../apps/web/src/styles.css';import '../../apps/web/src/digital-development-workspace.css';import '../../apps/web/src/cockpit-production-settings.css';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,mode=new URLSearchParams(location.search).get('mode');
const profile={customerCode:null,version:0,monthOffset:-2,shippingDay:null,suggestionDay:15,configured:false} as const;
const first:SeriesPlanSnapshot={revision:1,plannedShippingDate:'2027-03-15',route:'A',salesYear:2027,salesSeries:'P05',profile,milestones:seriesMilestones('2027-03-15','A'),plannedDurations:{},reason:'TEST已有计划，保留原客户承诺',createdBy:id(4),recordedAt:'2026-11-01T01:00:00Z'};
const makeState=(orderId:string):SeriesPlanState=>({orderId,serverToday:'2026-11-01',orderVersion:1,sourceId:id(2),canApply:mode!=='readonly',canRequest:true,canEditSeries:mode==='designer',active:true,salesYear:2027,salesSeries:'P05',requiresColorMatching:true,profile,customerDates:[{lineId:id(6),poNumber:'TEST-PO-A',color:'黑',date:'2027-03-10',version:1}],current:structuredClone(first),history:[structuredClone(first)],facts:[{key:'fabric_receipt',scopeRef:'whole',sourceDomain:'bulk-preparation',sourceRecordId:id(77),sourceVersion:1,completed:true,started:true,occurredAt:'2026-10-31T17:00:00Z',occurredDate:null,precision:'instant',reason:'TEST北京时间11月1日01:00'}],risks:[],pendingRequests:[]});
const states=new Map([[id(1),makeState(id(1))],[id(11),makeState(id(11))]]),completed=new Map<string,unknown>();
const control={requests:[] as Array<{path:string;method:string;body:unknown;key:string|null}>,failNext:false,loseResponse:false,failReadAfterSave:false,readFail:false};Object.assign(window,{seriesFixture:control});
window.fetch=async(input,init)=>{
 const path=new URL(String(input),location.origin).pathname,method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):null,key=new Headers(init?.headers).get('idempotency-key');control.requests.push({path,method,body,key});
 if(path.includes('/auth/'))return Response.json({status:'authorized',user:{id:id(4),displayName:'TEST供应链总监',capabilities:['digital_production:view']}});
 if(path.endsWith('/short-lead-requests'))return Response.json({canRequest:false,canApprove:false,serverToday:'2026-11-01',minimumNormalDate:'2026-12-01',requests:[]});
 if(path.endsWith('/series-profiles'))return Response.json({profiles:[]});
 const match=path.match(/orders\/([0-9a-f-]+)\/series-plan(.*)$/);if(!match)return Response.json({error:{message:'当前无可见原记录'}},{status:404});
 const state=states.get(match[1]!)!,action=match[2];
 if(method==='GET'){if(control.readFail){control.readFail=false;return Response.json({error:{message:'TEST最新状态暂不可读'}},{status:503});}return Response.json(state);}
 if(key&&completed.has(key))return Response.json(completed.get(key));
 if(action==='/preview'){
  const input=body as SeriesPreviewInput,candidateDate=input.plannedShippingDate??'2027-03-15',route=state.requiresColorMatching?'A':'B';
  const retained=retainSeriesTargets(seriesMilestones(candidateDate,route),state.current?.milestones??[],state.facts,input.selectedNodeIds,state.current?.revision??0);
  const p:SeriesPlanPreview={orderId:state.orderId,input,orderVersion:state.orderVersion,planRevision:state.current?.revision??0,profile,candidateDate,basis:input.plannedShippingDate?'manual':'series-suggestion',route,previewToken:'TEST-only-synthetic-preview-token',...retained,facts:state.facts,risks:[{code:'CUSTOMER_EARLIER_THAN_PLAN',tone:'danger',nodeId:null,message:`TEST-PO-A 客户约定出货 2027-03-10 早于计划 ${candidateDate}；系统不覆盖任一日期`},{code:'FACTORY_CAPACITY_UNKNOWN',tone:'unknown',nodeId:null,message:'工厂生产工期未确认，不能推断整单可按期'}],planningGraph:[],dependencies:[],sourceRevisionSet:{rule:'TEST-only'}};return Response.json(p);
 }
 if(control.failNext){control.failNext=false;state.orderVersion++;return Response.json({error:{code:'SERIES_PLAN_CONFLICT',message:'TEST资料已变化，请刷新；本次未覆盖'}},{status:409});}
 if(action==='/context'){state.salesYear=body.salesYear;state.salesSeries=body.salesSeries;state.requiresColorMatching=body.requiresColorMatching;state.orderVersion++;const result={orderVersion:state.orderVersion};if(key)completed.set(key,result);return Response.json(result);}
 if(action==='/apply'){
  if(body.expectedOrderVersion!==state.orderVersion||body.expectedPlanRevision!==(state.current?.revision??0))return Response.json({error:{message:'TEST原预览已过期'}},{status:409});
  const next:SeriesPlanSnapshot={...first,revision:(state.current?.revision??0)+1,plannedShippingDate:body.plannedShippingDate??'2027-03-15',reason:body.reason,milestones:retainSeriesTargets(seriesMilestones(body.plannedShippingDate??'2027-03-15',state.requiresColorMatching?'A':'B'),state.current?.milestones??[],state.facts,body.selectedNodeIds,state.current?.revision??0).milestones};state.current=next;state.history.unshift(next);if(key)completed.set(key,next);if(control.failReadAfterSave){control.failReadAfterSave=false;control.readFail=true;}if(control.loseResponse){control.loseResponse=false;throw new TypeError('TEST回执丢失');}return Response.json(next);
 }
 return Response.json({ok:true});
};
const node:JourneyNode={key:'budget',instanceId:id(20),label:'预算',stage:'preparation',state:'active',round:null,occurrence:null,current:true,owner:{id:id(3),name:'TEST订单跟单'},operator:null,assignmentHistory:[],expectedAt:null,expectedKind:'unset',expectedPrecision:'missing',actualAt:null,actualQuality:'missing',enteredAt:null,sla:'not_set',completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:[],inheritedFrom:null,countsInProgress:true,unavailableReason:null};
const order=(n=1):OrderJourney=>({seriesPlanVisible:true,id:id(n),orderId:id(n),sourceId:id(2),designStyleNo:`TEST-P05-${n}`,temporaryStyleNo:null,customer:'TEST 客户',category:'上衣',designer:null,merchandisers:[{id:id(3),name:'TEST订单跟单'}],orderNumbers:['TEST-ORDER'],createdAt:'2026-11-01T00:00:00Z',deliveryDate:'2027-03-10',poDeliveryDates:[{lineId:id(6),position:1,poNumber:'TEST-PO-A',color:'黑',customerWarehouseArrivalDate:'2027-03-10',factoryDeliveryDate:null,sampleTargetDate:null}],selectedRound:1,adoptedRound:1,sourceVersion:2,instructionVersion:1,lines:[],links:[],stages:JOURNEY_STAGES.map(s=>({...s,state:s.key==='preparation'?'active':'uncreated',nodes:s.key==='preparation'?[node]:[]})),progress:{development:null,bulk:null},hitReasons:[]});
function Fixture(){const [n,setN]=useState(1),[context,setContext]=useState<CockpitContext>({selected:id(1),expanded:'preparation',focus:id(20)});return mode==='settings'?<div className="cockpit-settings"><h1>生产管理设置 · TEST模拟数据</h1><SeriesSettings/></div>:<div className="dx-production-ui"><div className="digital-journey-cockpit dx-production-refined"><p>TEST模拟数据 · 真实页面组件复现，非现场业务记录</p><button type="button" onClick={()=>{void canLeaveInternalPage().then(leave=>{if(leave){setN(11);setContext({selected:id(11),expanded:'preparation'});}});}}>TEST切另一订单</button><CockpitDetail order={order(n)} context={context} onChange={p=>setContext(c=>({...c,...p}))} asOf="2026-11-01T00:00:00Z" actions={<button type="button">原订单操作</button>}/></div></div>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
