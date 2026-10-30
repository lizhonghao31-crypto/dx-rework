// Actual product components; only synthetic localhost HTTP responses. Not authorization proof.
import {createRoot} from 'react-dom/client';
import {DevelopmentCreateForm} from '../../apps/web/src/digital-development-create-form.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {FactoryFlowPanel} from '../../apps/web/src/factory-flow-panel.js';
import {observeAcceptanceTime} from '../../apps/web/src/acceptance-business-time.js';
import {minimumInitialCustomerDate} from '@dx-rework/contracts/digital-production';
import type {OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {DevelopmentSheet} from '@dx-rework/contracts/digital-development';
import type {FactoryFlowSheet} from '@dx-rework/contracts/factory-flow';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const query=new URLSearchParams(location.search),view=query.get('view')??'date',mode=query.get('mode')??'future';
const state={day:mode==='past'?'2026-10-15':mode==='future'?'2026-12-10':'2026-10-29',failCalendar:false,failDispatch:false,created:0,createdCallbacks:0,requests:[] as Array<{path:string;search:string;method:string;key:string|null;body:Record<string,unknown>|null}>};
Reflect.set(window,'pr2TimeFixture',state);
observeAcceptanceTime(id(999),'2099-01-01T00:00:00.000Z');
const factory:FactoryFlowSheet={orderId:id(2),preparationId:id(3),revision:0,secondaryCraft:'无',reasons:[],allCut:true,allQc:true,inTransit:false,dispatched:false,supplierId:id(4),supplierName:'TEST工厂',productionId:null,sampleTargetDate:null,canManage:false,canLogistics:false,canQc:false,canWarehouse:true,canFollowup:false,tasks:[],lines:[{lineId:id(5),poNumber:'TEST-PO',color:'黑',result:'合格',problem:'',treatment:''}],facts:[],checks:[],batchMode:mode!=='legacy',canPartialDispatch:true,batchTotals:[{lineId:id(5),quantity:10,sent:0,remaining:10,craftRemaining:0}],batches:[]};
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.origin),method=init?.method??'GET',headers=new Headers(init?.headers),body=init?.body?JSON.parse(String(init.body)):null;
 state.requests.push({path:url.pathname,search:url.search,method,key:headers.get('idempotency-key'),body});
 const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'x-request-id':'TEST-PR2-LOCAL'}});
 if(url.pathname.endsWith('/digital-production/options')){
  if(state.failCalendar)return json({error:{message:'TEST 日期暂不可读',code:'TEST_CALENDAR'}},500);
  const source=url.searchParams.get('sourceId');if(source&&source!==id(1))return json({message:'TEST来源不匹配'},409);
  const day=source?state.day:'2026-10-29';
  return json({creationEnabled:true,serverToday:day,minimumInitialCustomerDate:minimumInitialCustomerDate(new Date(`${day}T12:00:00+08:00`)),customers:[{code:'PD',name:'TEST客户',productGroups:['男装'],defaultMerchandiserId:null,defaultMerchandiserName:null}]});
 }
 if(url.pathname.endsWith('/factory-flow/dispatch')){
  if(state.failDispatch){state.failDispatch=false;return json({error:{message:'TEST 未取得成功回执',code:'TEST_UNKNOWN'}},500);}
  factory.dispatched=true;factory.revision++;return json(factory);
 }
 if(url.pathname.endsWith('/factory-flow'))return json(factory);
 if(url.pathname.endsWith('/access/candidates'))return json([]);
 if(url.pathname.endsWith('/confirm')){state.created++;return json({productionOrderId:id(2)});}
 return json({message:`Unexpected synthetic request: ${url.pathname}`},404);
};
const source={id:id(1),sourceId:id(1),designStyleNo:'TEST-PR2-DATE',temporaryStyleNo:null,customer:'PD',designer:'TEST设计师',selectedRound:1} as OrderJourney;
const saved={customerCode:'PD',productGroup:'男装',designStyleNo:source.designStyleNo,temporaryStyleNo:null,orderDate:'2026-10-15',primaryMerchandiserId:null,contractDeliveryDate:null,lines:[{formalPoNo:'TEST-SAVED-PO',poNumber:null,formalStyleNo:null,temporaryStyleNo:null,color:'TEST已保存',colorForeign:null,deliveryDate:null,customerWarehouseArrivalDate:'2028-03-01',sizes:[{size:'M',quantity:'10'}]}]};
const sheet={sourceId:id(1),productionOrderId:null,designStyleNo:source.designStyleNo,temporaryStyleNo:null,customerCode:'PD',developmentType:'头版',designerName:'TEST设计师',version:1,status:'published',publishedAt:'2026-10-15T00:00:00Z',taskId:id(6),canEdit:true,materialEvents:[],document:{...initialDevelopmentDocument(),...(query.has('saved')?{customerOrderDraft:{withOrder:true,order:saved}}:{})}} as DevelopmentSheet;
createRoot(document.getElementById('root')!).render(<main style={{maxWidth:1200,margin:'0 auto',padding:12}}>{view==='factory'?<FactoryFlowPanel orderId={id(2)} onClose={()=>undefined}/>:<DevelopmentCreateForm intent="confirm_order" source={source} existingDraft={sheet} customers={[{code:'PD',name:'TEST客户',productGroups:['男装'],defaultMerchandiserId:null,defaultMerchandiserName:null}]} serverToday="2026-10-29" minimumDate="2026-11-29" onCancel={()=>undefined} onCreated={()=>{state.createdCallbacks++;}}/>}</main>);
