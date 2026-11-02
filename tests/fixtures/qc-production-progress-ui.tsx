// Real factory parent/component, isolated HTTP fault simulation; not live acceptance.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FactoryFlowPanel} from '../../apps/web/src/factory-flow-panel.js';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,mode=new URLSearchParams(location.search).get('mode')??'normal',order=id(1),viewer=id(2),line=id(3),task=id(4);
const clock={state:'due',basis:'start',anchor:'2026-11-01T00:00:00Z',remindAt:'2026-11-03T00:00:00Z',escalateAt:'2026-11-04T00:00:00Z',windowKey:'start:TEST',reason:null};
let data={viewerId:viewer,orderId:order,asOf:'2026-11-03T00:00:00Z',canManage:true,canRecord:true,paused:false,qcUserId:viewer,qcName:'TEST QC',qualityLeadId:viewer,qualityLeadName:'TEST QC负责人',settingsVersion:1,archivedExecutions:[],executions:[{productionId:id(5),factoryDecisionId:null,supplierName:'TEST 加工厂',status:'in_production',scopeRevision:'a'.repeat(64),progressRevision:0,trackingId:id(6),trackingStartedAt:clock.anchor,trackingBasis:'warehouse_dispatch',clock,lineClocks:[{lineId:line,clock}],windows:[{key:'TEST',lineIds:[line],clock}],canRecord:mode!=='readonly',lines:Array.from({length:mode==='dense'?12:1},(_,i)=>({lineId:i?id(30+i):line,position:i+1,poNumber:`TEST-PO-${i+1} · 长名称用于布局验证`,color:'藏青',quantity:100,completedQuantity:10})),records:[] as Array<Record<string,unknown>>}]};
const factory={orderId:order,preparationId:id(7),revision:0,secondaryCraft:'无',reasons:[],allCut:true,allQc:true,inTransit:false,dispatched:true,supplierId:id(8),supplierName:'TEST 加工厂',productionId:id(5),sampleTargetDate:'2026-11-10',sampleAdvanceDays:10,canRecordShipSample:false,shipSamples:[],canManage:true,canLogistics:false,canQc:false,canWarehouse:false,canFollowup:false,canProductionQc:false,tasks:[{taskId:task,taskKind:'factory_production_qc',label:'工厂成衣QC',state:'ready',assigneeId:viewer,assigneeName:'TEST QC',requiredRole:'quality_control',unmetConditions:[],identity:{designStyleNo:'TEST-示例款'},dueAt:null,enteredAt:null}],lines:[{lineId:line,poNumber:'TEST-PO-1',color:'藏青',customerWarehouseArrivalDate:'2026-11-20',sampleTargetDate:'2026-11-10',result:null,problem:'',treatment:''}],facts:[],checks:[],productionChecks:[],productionInspectionHistory:[],returnLogistics:[],batchMode:false};
const requests:Array<{url:string;key:string;body:Record<string,unknown>}>=[],cache=new Map<string,Record<string,unknown>>();let writes=0,reads=0,refreshFailed=false,grants=0;const uploadAttempts=new Map<string,number>();
Reflect.set(window,'qcRequests',requests);Reflect.set(window,'qcWrites',()=>writes);
window.fetch=async(path,init)=>{
 const url=String(path),method=init?.method??'GET';
 if(url.endsWith('/access/candidates'))return Response.json([{id:viewer,displayName:'TEST QC负责人',roles:['quality_control']}]);
 if(url.endsWith('/factory-flow'))return Response.json(factory);
 if(url.endsWith('/qc-progress')&&method==='GET'){
  reads++;if(mode==='loadfail'&&reads===1)return Response.json({error:{code:'TEST',message:'TEST初次读取失败'}},{status:503});
  if(mode==='readfail'&&writes>0&&!refreshFailed){refreshFailed=true;throw Error('TEST保存后读取失败');}
  return Response.json(data);
 }
 if(url.includes('/upload-limits'))return Response.json({maxUploadBytes:1000000});
 if(url.endsWith('/upload-intents')){const body=JSON.parse(String(init?.body));const attachmentId=id(80+grants++);return Response.json({attachmentId,uploadUrl:`https://qc-upload.test/${attachmentId}`,uploadMethod:'POST',uploadFields:{key:attachmentId},expiresAt:'2099-01-01T00:00:00Z',filename:body.upload.filename});}
 if(url.startsWith('https://qc-upload.test/')){const attempts=uploadAttempts.get(url)??0;uploadAttempts.set(url,attempts+1);return new Response(null,{status:mode==='photos'&&url.endsWith(id(81))&&attempts===0?500:204});}
 if(url.endsWith('/finalize'))return Response.json({status:'ready'});
 if(method==='POST'&&url.includes('/qc-progress')){
  const body=JSON.parse(String(init?.body)),key=new Headers(init?.headers).get('idempotency-key')??'';requests.push({url,key,body});
  if(mode==='held')await new Promise<void>(resolve=>Reflect.set(window,'resolveQcWrite',resolve));
  if(mode==='reject')return Response.json({error:{code:'QC_PROGRESS_CONFLICT',message:'TEST范围已变化，原输入保留'}},{status:409});
  if(!cache.has(key)){
   writes++;let ack:Record<string,unknown>={committed:true};
   if(url.endsWith('/settings')){data={...data,settingsVersion:data.settingsVersion+1,qualityLeadId:body.qualityLeadId,qualityLeadName:'TEST QC负责人'};ack.version=data.settingsVersion;}
   else{const record={recordId:id(50+writes),relatedProgressRecordId:null,revision:data.executions[0]!.progressRevision+1,kind:body.kind,collectedAt:body.collectedAt,recordedAt:data.asOf,actorName:'TEST QC',observations:body.observations,criticalEvents:body.criticalEvents,attachmentIds:body.attachmentIds,reportIds:[],note:body.note};data={...data,executions:data.executions.map(e=>({...e,progressRevision:e.progressRevision+1,records:[record,...e.records]}))};ack={committed:true,submissionId:body.submissionId,recordId:record.recordId,progressRevision:record.revision,reportIds:[],attachmentIds:body.attachmentIds};}
   cache.set(key,ack);if(mode==='unknown')throw Error('TEST请求已保存但回执丢失');
  }
  return Response.json(cache.get(key));
 }
 throw Error(`Unexpected fixture request ${method} ${url}`);
};
function Fixture(){const [open,setOpen]=useState(true);return <><p>TEST 模拟记录与故障注入，复用真实发厂父页和办理组件。</p>{open?<FactoryFlowPanel orderId={order} onClose={()=>setOpen(false)}/>:<button onClick={()=>setOpen(true)}>重新进入原订单</button>}</>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
