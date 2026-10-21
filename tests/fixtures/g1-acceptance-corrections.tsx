// Product hosts and App route; synthetic local HTTP responses only. Real authorization/state is covered in PG tests.
import {createRoot} from 'react-dom/client';
import {App} from '../../apps/web/src/App.js';
import {verifySession} from '../../apps/web/src/auth.js';
import {DevelopmentAmendmentPanel} from '../../apps/web/src/development-amendment-panel.js';
import {OrderDocumentContainer} from '../../apps/web/src/order-document-container.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {initialDevelopmentOrder} from '../../apps/web/src/digital-development-create-form.js';
import type {AuxiliaryItem} from '@dx-rework/contracts/auxiliary-catalog';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/digital-development.css';
import '../../apps/web/src/workflow-shell.css';
import '../../apps/web/src/dialog-visual-system.css';
import '../../apps/web/src/workflow-state-visual.css';
import '../../apps/web/src/ui-polish.css';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,params=new URLSearchParams(location.search),mode=params.get('mode'),role=params.get('role')??'sample_designer';
const initial=initialDevelopmentDocument();
const document:DevelopmentDocument={...initial,quantity:2,sizeQuantities:[1,1],orderDate:'2026-10-21',customerOrderDraft:{withOrder:false,order:initialDevelopmentOrder([])},materials:[{...initial.materials[0]!,materialId:id(3),name:'TEST主布',specification:'TEST待核实规格',available:true},{...initial.materials[0]!,materialId:id(4),category:'辅料',label:'辅料',name:'TEST原辅料',specification:'TEST原规格',auxiliaryKind:'普通辅料',expectedDate:mode==='create'?null:'2099-12-31'}],files:params.has('noImage')?[]:[{attachmentId:id(5),kind:'款图'}]};
document.customerOrderDraft!.order.designStyleNo='TEST-G1';
if(mode==='create')document.materials[0]!.specification='TEST 100%棉180g';
const stored=sessionStorage.getItem('TEST-G1-amendment');
const state={document,draft:stored?JSON.parse(stored):null,requests:[] as {path:string;method:string;body:unknown;key:string|null}[],catalog:[{id:id(10),version:1,name:'TEST扁机完整名称',specification:'TEST40cm',supplier:'TEST厂',auxiliaryKind:'扁机',active:true,mergedInto:null,changedAt:'2026-10-21T00:00:00Z'}] as AuxiliaryItem[],sequence:20};
Object.assign(window,{g1Fixture:state});
window.fetch=async(input,init)=>{
 const url=new URL(String(input),location.origin),path=url.pathname,method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):null,key=new Headers(init?.headers).get('idempotency-key');state.requests.push({path,method,body,key});
 const allowed=role!=='development_clerk',root=role==='root_superuser';
 if(path.endsWith('/auth/me'))return Response.json({status:'authorized',user:{id:id(100),displayName:`TEST ${role}`,businessRoles:[role],isRoot:root,capabilities:root?[]:['auxiliary_catalog:read',...(allowed?['auxiliary_catalog:write']:[]),'digital_production:view','pattern_room:orders:create']}});
 if(path.includes('/todos/'))return Response.json({pendingCount:0});
 if(path.includes('/master-data/auxiliaries')){
  if(!allowed)return Response.json({error:{message:'TEST无目录权限'}},{status:403});
  if(method==='GET'){const q=url.searchParams.get('q')??'',items=state.catalog.filter(item=>(url.searchParams.get('includeInactive')==='true'||item.active)&&item.name.includes(q));return Response.json({items,total:items.length,page:1,pageSize:15,canManage:true});}
  if(!key)throw Error('Missing catalog operation key');
  const item=state.catalog.find(item=>path.includes(item.id));
  if(!item){const created={id:id(state.sequence++),version:1,...body,active:true,mergedInto:null,changedAt:'2026-10-21T00:00:00Z'};state.catalog.push(created);return Response.json(created);}
  if(item.version!==body.expectedVersion)return Response.json({error:{message:'TEST过期版本'}},{status:409});
  item.version++;if(path.endsWith('/versions'))item.name=body.name;else if(path.endsWith('/merge')){item.active=false;item.mergedInto=body.targetId;}else if(path.endsWith('/disable'))item.active=false;else throw Error('Unexpected catalog action');return Response.json(item);
 }
 if(path.includes('/amendment')){
  if(method==='GET')return Response.json({sourceId:id(1),taskId:id(2),roundNumber:1,documentVersion:2,document:state.document,issues:[{materialId:id(3),field:'specification',need:'document',reason:'TEST主布规格待核实'}],directSupplyMode:null,note:'TEST按规格补正',draft:state.draft});
  if(method==='PUT'){state.draft={version:(state.draft?.version??0)+1,document:body.document,reason:body.reason};sessionStorage.setItem('TEST-G1-amendment',JSON.stringify(state.draft));return Response.json({draftVersion:state.draft.version,documentVersion:2,originatingTaskId:id(2)});}
  throw Error('Unexpected amendment submission in host-only scenario');
 }
 if(path.includes('/document-directory/'))return Response.json({development:{state:'available',id:id(1),version:1},budget:{state:'not_applicable'},instruction:{state:'not_applicable'}});
 if(path.endsWith('/development'))return Response.json({sourceId:id(1),designStyleNo:'TEST-G1',temporaryStyleNo:null,customerCode:null,developmentType:'头版',designerName:'TEST设计师',version:1,status:'draft',document:state.document,publishedAt:null,taskId:null,canEdit:true,materialEvents:[]});
 if(path.endsWith('/options'))return Response.json({customers:[],serverToday:'2026-10-21',minimumInitialCustomerDate:'2026-11-21'});
 if(path.endsWith('/category-options'))return Response.json([]);
 if(path.includes('/attachments/')&&path.endsWith('/metadata'))return Response.json({filename:'TEST款图.png',mimeType:'image/png',sizeBytes:1});
 if(path.endsWith('/attachments/options'))return Response.json({});
 throw Error(`Unexpected synthetic request: ${method} ${path}`);
};
void verifySession().then(()=>createRoot(window.document.getElementById('root')!).render(mode==='amendment'?<DevelopmentAmendmentPanel sourceId={id(1)} taskId={id(2)} onSubmitted={async()=>undefined}/>:mode==='create'?<OrderDocumentContainer initial={{kind:'development',id:id(1)}} onClose={()=>undefined}/>:<App/>));
