import {createRoot} from 'react-dom/client';
import {Shell} from '../../apps/web/src/components.js';
import {verifySession} from '../../apps/web/src/auth.js';
import {ProductionWorkspace} from '@dx-rework/ui/production';
import {DigitalPatternWorkspace} from '../../apps/web/src/digital-pattern-workspace.js';
import {DigitalDesignerWorkspace} from '../../apps/web/src/digital-designer-workspace.js';
import {BulkPatternWorkspace} from '../../apps/web/src/bulk-pattern-workspace.js';
import {DigitalProductionWorkspace} from '../../apps/web/src/digital-production-workspaces.js';
import {DigitalCockpitPage} from '../../apps/web/src/digital-cockpit-page.js';
import {LegacyPatternWorkspace} from '../../apps/web/src/legacy-pattern-workspace.js';
import {PATTERN_GROUPS,PATTERN_LANES,type PatternWorkspaceTask} from '@dx-rework/contracts/digital-development-workspace';
import {JOURNEY_NODES,JOURNEY_STAGES,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {journeyDisplay} from '../../apps/api/src/production-platform/journey-display.js';
import type {PatternOrderSummary} from '@dx-rework/contracts/pattern-orders';
import '@dx-rework/ui/tokens.css';import '@dx-rework/ui/components.css';import '../../apps/web/src/styles.css';
import '../../apps/web/src/workflow-shell.css';import '../../apps/web/src/workflow-state-visual.css';
import '../../apps/web/src/dialog-visual-system.css';import '../../apps/web/src/ui-polish.css';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,now='2026-10-20T00:00:00Z';
const params=new URLSearchParams(location.search),mode=params.get('mode')??'pattern',noCreate=params.has('noCreate');
const access={manage:false,customers:false,approveDelivery:false,create:true,actorId:id(1),roles:['development_clerk']};
const state={requests:[] as {path:string;method:string;body:unknown;key:string|null}[],unexpected:[] as string[],releaseSlow:null as null|(()=>void),slowSettled:false,failPost:true,posts:0};Object.assign(window,{uatWorkspaceFixture:state});
const tasks:PatternWorkspaceTask[]=PATTERN_LANES.flatMap((lane,laneIndex)=>Array.from({length:5},(_,index)=>{
 const key=PATTERN_GROUPS.find(group=>group.key===lane.groups[0])!.nodes[0],definition=JOURNEY_NODES.find(node=>node.key===key)!;
 return {journeyId:id(100+laneIndex*10+index),sourceId:id(200+laneIndex*10+index),orderId:null,designStyleNo:`TEST-LJY-${laneIndex}-${index}`,customer:'TEST客户',designer:'TEST设计师',group:lane.groups[0],node:{key,instanceId:id(300+laneIndex*10+index),label:definition.label,stage:definition.stage,state:'active',round:1,occurrence:1,current:true,owner:{id:id(1),name:'TEST师傅'},operator:null,assignmentHistory:[],expectedAt:'2026-10-23',expectedKind:'plan',expectedPrecision:'date',actualAt:null,actualQuality:'missing',enteredAt:now,sla:'not_started',completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:[],inheritedFrom:null,countsInProgress:true,unavailableReason:null}};
}));
const matches=(text:string,q:string)=>text.toLowerCase().includes(q.toLowerCase());
const pattern=(query:URLSearchParams)=>{const search=query.get('search')??'',lane=PATTERN_LANES.find(l=>l.key===query.get('lane')),filtered=tasks.filter(t=>matches(t.designStyleNo,search)&&(query.get('state')!=='completed')),visible=filtered.filter(t=>!lane||(lane.groups as readonly string[]).includes(t.group)),page=Number(query.get('page')??1);return {asOf:now,page,pageSize:15,total:visible.length,archiveTotal:visible.length,owners:[],counts:Object.fromEntries(PATTERN_GROUPS.map(g=>[g.key,filtered.filter(t=>t.group===g.key).length])),riskCounts:Object.fromEntries(PATTERN_GROUPS.map(g=>[g.key,{dueSoon:0,overdue:0}])),items:visible.slice((page-1)*15,page*15),boardPreview:PATTERN_LANES.flatMap(l=>visible.filter(t=>(l.groups as readonly string[]).includes(t.group)).slice(0,3))};};
const journeys:OrderJourney[]=Array.from({length:19},(_,index)=>{const task=tasks[index]!,item:OrderJourney={id:id(500+index),sourceId:task.sourceId,orderId:id(600+index),designStyleNo:`TEST-LJY-ORDER-${index}`,temporaryStyleNo:null,customer:'TEST客户',category:'上衣',designer:'TEST设计师',styleName:'TEST上衣',merchandisers:[],orderNumbers:[`TEST-MOTHER-${index}`],createdAt:now,deliveryDate:null,selectedRound:1,adoptedRound:null,sourceVersion:1,instructionVersion:null,lines:[],links:[],stages:JOURNEY_STAGES.map(stage=>({...stage,state:'active',nodes:task.node.stage===stage.key?[task.node]:[]})),progress:{development:null,bulk:null},hitReasons:[]};item.display=journeyDisplay(item,now);return item;});
const misc:PatternOrderSummary[]=Array.from({length:22},(_,index)=>({orderId:id(800+index),orderNo:`TEST-BF-${index+1}`,kind:'misc',taskName:index===1?'TEST-LJY-长任务名称，保留原内容和关联身份，可在本记录完整阅读':'TEST-LJY-杂事任务'+(index+1),status:index%3===0?'completed':index%3===1?'pending_assignment':'in_progress',version:1,styleNo:index%2?'TEST-PO-LJY':'',creatorId:id(1),creatorName:'TEST申请人',currentWorkerName:index%2?'TEST师傅':null,requiredDate:index%2?'2026-10-23':null,reworkCount:0,submittedAt:now,updatedAt:now}));
window.fetch=async(input,init)=>{
 const path=String(input),method=init?.method??'GET',url=new URL(path,location.origin),body=init?.body?JSON.parse(String(init.body)):null;state.requests.push({path,method,body,key:new Headers(init?.headers).get('idempotency-key')});
 if(path.endsWith('auth/me'))return Response.json({status:'authorized',user:{id:id(1),displayName:'TEST验收账号',isRoot:!noCreate,businessRoles:noCreate?['pattern_room_worker']:['root_superuser','sample_designer'],capabilities:['pattern_room:orders:view',...(noCreate?[]:['pattern_room:misc:create','pattern_room:orders:create'])]}});
 if(path.includes('/todos'))return Response.json({items:[],total:0,count:0});
 if(path.endsWith('/access/options'))return Response.json(access);
 if(path.endsWith('/options'))return Response.json({creationEnabled:true,customers:[{code:'TEST',name:'TEST客户',productGroups:['男装'],defaultMerchandiserId:null,defaultMerchandiserName:null}],serverToday:'2026-10-20',minimumInitialCustomerDate:'2026-11-20'});
 if(path.includes('/attachments/upload-limits?'))return Response.json({maxUploadBytes:10*1024*1024});
 if(path.endsWith('/hourly-quote'))return Response.json({priceId:id(2),name:'TEST小时价',unit:'小时',amount:'10.000',version:1});
 if(path.includes('/misc-associations?'))return Response.json([]);
 if(url.pathname.endsWith('/pattern-room/misc-orders')&&method==='POST'){
  state.posts++;if(state.failPost){state.failPost=false;return Response.json({error:{message:'TEST提交失败，输入保留'}},{status:503});}
  sessionStorage.setItem('uatMiscPosts',JSON.stringify(state.requests.filter(r=>r.method==='POST')));
  return Response.json({...misc[0],orderId:id(999),status:'pending_assignment',currentRoundId:id(998),customer:null,sizeColor:null,referenceStyleNo:null,variant:null,note:body.note,rounds:[],attachments:[],history:[],actions:{delete:false,assign:false,complete:false,handoff:false,edit:false,hours:false,rework:false,transfer:false,cancel:false,cancelFees:false}});
 }
 if(url.pathname.endsWith('/pattern-room/orders')){const page=Number(url.searchParams.get('page')??1),q=url.searchParams.get('q')??'',rows=misc.filter(o=>matches(o.taskName??'',q)&&(!url.searchParams.get('status')||o.status===url.searchParams.get('status')));return Response.json({items:rows.slice((page-1)*15,page*15),totalCount:rows.length,page,pageSize:15,totalPages:Math.max(1,Math.ceil(rows.length/15)),canCreate:false,canCreateMisc:!noCreate,canFilterPeople:false,canDelete:false});}
 const q=url.searchParams.get('search')??'';
 let result:unknown;
 if(path.includes('/workspaces/pattern'))result=pattern(url.searchParams);
 else if(path.includes('/workspaces/bulk-pattern'))result={total:0,page:1,pageSize:15,items:[]};
 else if(path.includes('/workspaces/designer')){const rows=journeys.filter(j=>matches(j.designStyleNo,q)),page=Number(url.searchParams.get('page')??1);result={asOf:now,page,pageSize:15,total:rows.length,counts:{all:rows.length,draft:rows.length,developing:0,awaiting_order:0,ordered:0},customers:['TEST客户'],designers:['TEST设计师'],items:rows.slice((page-1)*15,page*15).map(journey=>({journey:{...journey,orderId:null},view:'draft',canConfirm:false}))};}
 else if(url.pathname.endsWith('/journeys')){const rows=journeys.filter(j=>matches(j.designStyleNo,q));result={ruleVersion:'journey-v2.0',asOf:now,page:1,pageSize:15,total:rows.length,summary:{all:rows.length,active:0,notStarted:rows.length,dueSoon:0,overdue:0,blocked:0,completed:0},scopeCounts:{production:rows.length,development:0,cancelled:0},items:rows.slice(0,15),facets:{customers:['TEST客户'],categories:['上衣'],merchandisers:[]}};}
 if(result!==undefined){if(q==='slow')return await new Promise<Response>(resolve=>{state.releaseSlow=()=>{state.slowSettled=true;resolve(Response.json({...result as object,total:999}));};});return Response.json(result);}
 state.unexpected.push(`${method} ${path}`);return Response.json({error:{message:'TEST未配置读取'}},{status:404});
};
void verifySession().then(()=>createRoot(document.getElementById('root')!).render(<Shell appearance="digital" active={mode==='designer'?'digital-designer':mode==='cockpit'?'生产管理座舱':'digital-pattern'}><ProductionWorkspace>{mode==='misc'?<div className="pattern-workspace pattern-golden dx-production-refined"><LegacyPatternWorkspace/></div>:mode==='designer'?<DigitalDesignerWorkspace/>:mode==='bulk'?<BulkPatternWorkspace orderId={null} canViewAll/>:mode==='production'?<DigitalProductionWorkspace kind="preparation"/>:mode==='cockpit'?<DigitalCockpitPage/>:<DigitalPatternWorkspace initialAccess={access}/>}</ProductionWorkspace></Shell>));
