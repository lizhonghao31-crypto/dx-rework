// Real creation component and inherited styles; synthetic API is isolated from business data.
import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {DevelopmentCreateForm,initialDevelopmentOrder,type DevelopmentCreateIntent} from '../../apps/web/src/digital-development-create-form.js';
import {initialDevelopmentDocument,type DevelopmentOrderDraft} from '../../apps/web/src/digital-development-editing.js';
import {SaveDevelopmentSchema,developmentPublishErrors,type DevelopmentSheet,type DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import {DigitalOrderCreateSchema,initialCustomerDateErrors} from '@dx-rework/contracts/digital-production';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/digital-development-workspace.css';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const params=new URLSearchParams(location.search),withOrder=!params.has('pure'),fresh=params.has('fresh');
const customers=[{code:'PD',name:'TEST 客户',productGroups:['男装'],defaultMerchandiserId:null}];
const order:DevelopmentOrderDraft={...initialDevelopmentOrder(customers),customerCode:'PD',designStyleNo:'TEST-OPTIONS',orderDate:'2026-11-01',salesYear:params.has('historical')?2025:null,salesSeries:null,lines:[{formalPoNo:'TEST-PO-01',poNumber:null,formalStyleNo:null,temporaryStyleNo:null,color:'TEST 蓝',colorForeign:null,deliveryDate:null,customerWarehouseArrivalDate:'2027-03-15',sizes:[{size:'',quantity:''}]}]};
const document:DevelopmentDocument={...initialDevelopmentDocument(),quantity:1,orderDate:'2026-11-01',materials:[],patternCategoryId:id(2),files:[{attachmentId:id(3),kind:'款图' as const}],customerOrderDraft:{withOrder,order}};
if(params.has('preorder')||params.has('preorderReady'))document.customerOrderDraft={withOrder:true,order,stage:'preorder'};
if(params.has('preorder')){document.quantity=null;document.files=[];document.patternCategoryId=null;order.customerCode='';order.orderDate='';}
const restore=params.has('missingDate')||params.has('shortDate')||params.has('futureOrderDate')||params.has('crossDay')||params.has('mixedDate');
if(restore)order.lines[0]!.sizes=[{size:'M',quantity:'12'}];
if(params.has('missingDate'))order.lines[0]!.customerWarehouseArrivalDate=null;
if(params.has('shortDate'))order.lines[0]!.customerWarehouseArrivalDate='2026-11-15';
if(params.has('futureOrderDate'))order.orderDate='2026-11-02';
if(params.has('crossDay'))order.lines[0]!.customerWarehouseArrivalDate='2026-12-01';
if(params.has('mixedDate'))order.lines.push({...order.lines[0]!,formalPoNo:'TEST-PO-02',color:'TEST红',customerWarehouseArrivalDate:'2026-11-15'});
const state={saved:{sourceId:id(1),designStyleNo:order.designStyleNo,temporaryStyleNo:null,customerCode:params.has('preorder')?null:'PD',developmentType:'头版',designerName:'TEST 设计师',version:1,status:'draft',document,publishedAt:null,taskId:null,canEdit:true,materialEvents:[]} as DevelopmentSheet,
  requests:[] as Array<{path:string;method:string;body:unknown}>,failNextSave:false,failNextConfirm:false,created:0,orderId:null as string|null,calendar:params.has('crossDay')?{serverToday:'2026-11-02',minimumInitialCustomerDate:'2026-12-02'}:{serverToday:'2026-11-01',minimumInitialCustomerDate:'2026-12-01'}};
if(restore)state.saved={...state.saved,status:'published',version:2};
Object.assign(window,{creationOptionsFixture:state});
window.fetch=async(input,init)=>{
  const path=String(input),method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):null;
  state.requests.push({path,method,body});
  if(path.includes('/auth/'))return Response.json({status:'authorized',user:{id:id(9),displayName:'TEST 设计师',capabilities:['pattern_room:orders:create']}});
  if(path.includes('/design-codes/check'))return Response.json({code:new URL(path,location.href).searchParams.get('code'),available:!path.includes('USED')});
  if(path.includes('/options'))return Response.json({...state.calendar,customers});
  if(path.endsWith('/category-options'))return Response.json([{priceId:id(2),name:'TEST 短袖上衣',unit:'件'}]);
  if(path.endsWith('/quote'))return Response.json({priceId:id(2),name:'TEST 短袖上衣',unit:'件',amount:'40.000',version:1});
  if(path.includes('/attachments/')){
    if(path.endsWith('/metadata'))return Response.json({filename:'TEST现有款图.png',mimeType:'image/png',sizeBytes:68});
    return new Response(Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7V8AAAAASUVORK5CYII='),c=>c.charCodeAt(0)),{headers:{'content-type':'image/png'}});
  }
  if(path.endsWith('/development/publish')){
    const errors=developmentPublishErrors(state.saved.document!);if(errors.length)return Response.json({error:{message:errors.join('；')}},{status:400});
    state.saved={...state.saved,status:'published',version:state.saved.version+1};return Response.json(state.saved);
  }
  if(path.endsWith('/confirm')){
    if(state.failNextConfirm){state.failNextConfirm=false;return Response.json({error:{message:'TEST 确认失败，输入保留'}},{status:503});}
    const parsed=DigitalOrderCreateSchema.parse(body),errors=initialCustomerDateErrors(parsed.lines,state.calendar.minimumInitialCustomerDate);
    if(errors.length)return Response.json({error:{message:errors.join('；')}},{status:400});
    return Response.json({...parsed,productionOrderId:id(8)});
  }
  if(path.endsWith('/development')){
    if(method==='PUT'){
      if(state.failNextSave){state.failNextSave=false;return Response.json({error:{message:'TEST 保存失败，输入保留'}},{status:503});}
      const parsed=SaveDevelopmentSchema.parse(body);if(parsed.expectedVersion!==state.saved.version)return Response.json({error:{message:'TEST 版本冲突'}},{status:409});
      state.saved={...state.saved,version:state.saved.version+1,document:structuredClone(parsed.document)};
    }
    return Response.json(state.saved);
  }
  if(path.includes('/sources?'))return Response.json({items:[],page:1});
  throw new Error(`Unmapped creation fixture: ${method} ${path}`);
};
function Fixture(){
  const [done,setDone]=useState(false);
  const [intent,setIntent]=useState<DevelopmentCreateIntent>(withOrder?'certain_order':'development');
  return done?<p role="status">TEST 开发已发布，正式订购配码待后续确认</p>:<DevelopmentCreateForm intent={intent} onIntentChange={setIntent} {...(fresh?{}:{existingDraft:structuredClone(state.saved)})} {...(params.has('crossDay')?{calendarSourceId:id(1)}:{})} customers={customers} serverToday="2026-11-01" minimumDate="2026-12-01" onCancel={()=>{}} onCreated={(_id,orderId)=>{state.created++;state.orderId=orderId;setDone(true);}}/>;
}
createRoot(window.document.getElementById('root')!).render(<Fixture/>);
