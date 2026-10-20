// Actual task/workspace components with intercepted TEST facts; original APIs only.
import '../../apps/web/src/App.js';
import {createRoot} from 'react-dom/client';
import {ProductionWorkspace} from '@dx-rework/ui/production';
import {TaskWorkbenchSample} from '../../apps/web/src/task-workbench-sample.js';
import {DigitalTasksPanel} from '../../apps/web/src/digital-production-tasks-panel.js';
import {BulkTaskWorkbench} from '../../apps/web/src/bulk-task-workbench.js';
import {FactoryFlowPanel} from '../../apps/web/src/factory-flow-panel.js';
import {DigitalDevelopmentPanel} from '../../apps/web/src/digital-development-panel.js';
import {DevelopmentExecutionPanel} from '../../apps/web/src/digital-development-execution-panel.js';
import type {MaterialBulkRules} from '@dx-rework/contracts/digital-development-execution';
import {MATERIAL_CHECK_FIELDS} from '@dx-rework/contracts/digital-development-execution';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {Shell} from '../../apps/web/src/components.js';
import {AuthGate,verifySession} from '../../apps/web/src/auth.js';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import type {DevelopmentSheet} from '@dx-rework/contracts/digital-development';
import type {BulkPreparationSheet} from '@dx-rework/contracts/bulk-preparation';
import type {FactoryFlowSheet} from '@dx-rework/contracts/factory-flow';
import '@dx-rework/ui/tokens.css';
import '@dx-rework/ui/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/workflow-shell.css';
import '../../apps/web/src/dialog-visual-system.css';
import '../../apps/web/src/workflow-state-visual.css';
import '../../apps/web/src/ui-polish.css';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,now='2026-10-17T00:00:00Z';
const scenario=new URLSearchParams(location.search).get('fixtureScenario')??'ready',requests:{path:string;method:string;body:unknown}[]=[];let roundsReads=0;
const paused=scenario.includes('paused'),checking=scenario==='material-check'||scenario.startsWith('material-closure'),supplying=scenario==='material-supply',factory=scenario.startsWith('factory'),bulk=scenario.startsWith('bulk');
const workerRole=checking?'development_clerk':supplying?'sample_designer':factory?'warehouse_receiver':'pattern_room_worker';
const task:DigitalTask={taskId:id(900),orderId:bulk||factory?id(902):null,sourceId:bulk||factory?null:id(901),taskKind:checking?'development_material_recheck':supplying?'development_material_supply':factory?'warehouse_dispatch':bulk?'bulk_pattern':scenario==='material-basis'?'development_cutting':'development_printing',label:checking?'面辅料复核':supplying?'补充材料':factory?'仓库发厂':bulk?'大货纸样':scenario==='material-basis'?'裁板':'印花',identity:{designStyleNo:bulk||factory?'TEST-BULK-正式款号':'TEST-DEV-开发款号',customerCode:'TEST-PD'},assigneeId:id(1),assigneeName:'TEST 张师傅',state:scenario==='historical'?'completed':scenario==='waiting-material'?'pending':'ready',routeVersion:2,occurrence:1,enteredAt:now,recordedAt:now,completedAt:null,paused,dueAt:'2026-10-19T00:00:00Z',warningAt:null,slaHours:48,policyVersion:1,routeProgress:{applicable:3,completed:1,cancelled:0},requiredRole:workerRole,hasHandover:false,canManage:false,canCorrect:false,canControl:false,timeQuality:'现场登记',blockedReason:null,canExecute:!paused&&scenario!=='fabric-director',unmetConditions:['waiting-material','material-basis'].includes(scenario)?[{condition:'material_ready',name:'实物到料',missing:'TEST 主面料未到',responsibleRole:'development_clerk',action:'请由文员核对本轮材料实物',evidenceId:null,verified:false}]:[]};
if(scenario==='bulk-blockers'||scenario==='multiple-blockers')task.unmetConditions=[
 {condition:'assignee',name:'办理人',missing:'TEST 尚未安排办理人',responsibleRole:'development_clerk',action:'请开发文员在本单总委派安排有效人员；技术主管可接管',evidenceId:null,verified:true},
 {condition:'predecessor',name:'上游纸样',missing:'TEST 纸样尚未完成',responsibleRole:'pattern_room_worker',action:'请纸样师从我的待办办理本单纸样',evidenceId:null,verified:true},
 {condition:'unknown',name:'条件待核实',missing:'TEST 系统尚未提供具体业务原因',responsibleRole:'系统管理员',action:'请重新读取任务；仍存在时提供任务链接给管理员',evidenceId:null,verified:false}];
const material={materialId:id(800),category:'主布' as const,label:'主面料',supplier:'TEST 供应商',name:'TEST 深蓝弹力牛仔布',width:'150cm',weight:'240g',composition:'棉',consumption:'2米',color:'深蓝',specification:'TEST 斜纹150cm',quantity:'10米',requiredThisRound:true,available:false,expectedDate:'2026-10-18'};
const sheet:DevelopmentSheet={sourceId:id(901),designStyleNo:'TEST-DEV-开发款号',temporaryStyleNo:null,customerCode:'TEST-PD',developmentType:'头版',designerName:'TEST 设计师',version:5,status:'published',document:{...initialDevelopmentDocument(),quantity:2,sizeQuantities:[2,0],sampleSize:'M',instructions:'TEST 保留原制作要求',craft:'印花',materials:[material]},publishedAt:now,taskId:id(900),canEdit:supplying,materialEvents:[],roundNumber:scenario==='historical'?3:2,latestRoundNumber:scenario==='historical'?3:2};
const rounds={rounds:[{roundNumber:2,origin:'内部发现',customerComment:'',internalProblem:'TEST 尾查退回：印花色差',explanation:'TEST 原尾查退回后复版',affectedNodes:['工艺'],inherited:{development_pattern:{taskId:id(700),roundNumber:1},development_cutting:{taskId:id(701),roundNumber:1},development_sewing:{taskId:id(702),roundNumber:1}}},{roundNumber:3,origin:'客户新增要求',customerComment:'TEST 后续别轮问题',internalProblem:'',explanation:'TEST 第三轮',affectedNodes:['车板'],inherited:{}}],draft:null};
const priorMaterialTask={...task,taskId:id(810),taskKind:'development_materials',state:'completed',label:'核配'};
const execution={fabricCases:scenario.startsWith("fabric")?[{reportId:id(830),reportedAt:now,reportedBy:"TEST 报告人",payload:{note:"TEST 原面料缩水报告",attachmentIds:[id(831)]},decisionId:null,decision:null,decidedAt:null,decidedBy:null,status:"等待决定",scope:null,responsible:[]}]:[],sheet,tasks:checking||supplying?[priorMaterialTask,task]:[task],patternOrder:null,routeFacts:[{factId:id(820),taskId:id(821),routeVersion:1,kind:'尾查退回',payload:{note:'TEST 尾查退回：印花色差'},recordedAt:now}],dispatch:null,facts:[...(checking||supplying?[{factId:id(811),taskId:id(810),kind:'缺项退回',payload:{note:'TEST 纽扣颜色不符',items:[]},recordedAt:now}]:[]),...(scenario.startsWith('fabric')?[{factId:id(830),taskId:null,kind:'面料报告',payload:{recommendation:'建议停用',note:'TEST 原面料缩水报告',attachmentIds:[id(831)]},recordedAt:now}]:[])],canReportFabric:scenario==='fabric-worker',canDispatch:false,canDecideFabric:scenario==='fabric-director'||scenario==='fabric-readonly',qrAvailable:false,materialReadiness:[{materialId:id(800),available:false,verified:false,missing:['待到料'],evidenceId:null}]};
if(scenario==='material-check'&&!new URLSearchParams(location.search).has('fixtureLegacy'))Object.assign(execution,{materialVerification:{version:0,documentVersion:5,taskId:null,note:'',result:'通过',entries:[{materialId:material.materialId,usage:'use',physical:false,quantity:false,color:false,specification:false,note:'',confirmedWith:'',changedBy:null,changedAt:null,invalidated:[]}]}});
if(scenario.startsWith('material-closure')){
 const document=sheet.document!;document.materials[0]!.requiredThisRound=false;
 document.materials.push({...material,materialId:id(801),category:'配布',name:'TEST 配布',label:'配布 B'},initialDevelopmentDocument().materials[2]!);
 Object.assign(execution,{materialVerification:JSON.parse(localStorage.getItem('TEST-material-verification')||'null')??{version:0,documentVersion:5,taskId:null,note:'',result:'通过',entries:document.materials.slice(0,2).map(m=>({materialId:m.materialId,usage:'pending',physical:false,quantity:false,color:false,specification:false,note:'',confirmedWith:'',changedBy:null,changedAt:null,invalidated:[]}))},
 fabricCases:[JSON.parse(localStorage.getItem('TEST-fabric-case')||'null')??{reportId:id(830),reportedAt:now,reportedBy:'TEST 师傅',payload:{note:'TEST 色牢度风险，不得自动放行',attachmentIds:[id(831)]},decisionId:null,decision:null,decidedAt:null,decidedBy:null,status:'等待决定',scope:{roundNumber:2,documentVersion:5,materials:[material]},responsible:[{id:id(8),name:'TEST 总监'}]}],canDecideFabric:scenario!=='material-closure-clerk'});
 task.canExecute=scenario!=='material-closure-director';
}
const closure=execution as typeof execution&{materialVerification:{bulkRules?:MaterialBulkRules;version:number;documentVersion:number;taskId:string|null;note:string;result:string;entries:Array<{materialId:string;usage:string;physical:boolean;quantity:boolean;color:boolean;specification:boolean;note:string;confirmedWith:string;changedBy:string|null;changedAt:string|null;invalidated:string[]}>}};
const bulkCount=Number(new URLSearchParams(location.search).get('fixtureMaterials')??0);
if(scenario.startsWith('material-closure')&&bulkCount>0){
 const count=Math.min(100,bulkCount);sheet.document!.materials=Array.from({length:count},(_,i)=>({...material,materialId:id(1000+i),name:`TEST 材料${i+1}长名称`,available:i!==3,color:'深蓝',specification:i===5?'':'TEST 规格长文字 150cm',...(i===3?{category:'辅料' as const,auxiliaryKind:'拉链' as const}: {})}));
 const stored=JSON.parse(localStorage.getItem(`TEST-bulk-${count}`)||'null');
 closure.materialVerification=stored??{version:0,documentVersion:5,taskId:null,note:'',result:'通过',entries:sheet.document!.materials.map((m,i)=>({materialId:m.materialId,usage:i===1?'pending':i===2?'unused':'use',physical:i===6,quantity:false,color:false,specification:false,note:i===2?'TEST设计师确认不用':'',confirmedWith:i===2?'TEST设计师':'',changedBy:null,changedAt:null,invalidated:[]}))};
 closure.fabricCases=[];
}
function fixtureBulkRules():MaterialBulkRules{
 return sheet.document!.materials.map((m,i)=>({materialId:m.materialId,checks:Object.fromEntries(MATERIAL_CHECK_FIELDS.map(field=>{
  const conflict=bulkCount>0&&((i===3&&field==='physical')||(i===4&&field==='color'));
  const reason=conflict?'TEST 已记录缺料／颜色不符，待实际处理':field==='physical'&&!m.available?'TEST 实物尚未到料':field==='specification'&&!m.specification?'TEST 规格未登记':closure.fabricCases.some(report=>report.status!=='允许使用')?'TEST 有待处理质量报告':null;
  return [field,{canSelect:!reason,knownConflict:conflict,reason}];
 })) as MaterialBulkRules[number]['checks']}));
}
const bulkSheet:BulkPreparationSheet={reference:{designStyleNo:'TEST-BULK-正式款号',customerCode:'TEST-PD',styleImageUrl:null,instructionVersion:3,sourceRound:2},cutting:{mode:'in_house',completed:false,lines:[{lineId:id(905),poNumber:'TEST-PO-01',formalStyleNo:'TEST-PO-01',temporaryStyleNo:null,color:'深蓝',cuttingOrderId:null,orderQuantity:100,actualCutCount:null,pieceCount:null,corrected:false}]},orderId:id(902),instructionVersion:3,sourceRound:2,adoptedRound:2,customerConfirmed:true,ownerApproved:true,instructionValid:true,reasons:[],preparationId:id(904),preshrink:null,dispatch:{version:1,patternWorkerId:id(1),warehouseWorkerId:null,cuttingWorkerId:null},canDispatchPattern:false,canDispatchWarehouse:false,facts:[],tasks:[task]};
const factorySheet:FactoryFlowSheet={orderId:id(902),preparationId:id(904),revision:1,secondaryCraft:'无',reasons:[],allCut:true,allQc:true,inTransit:false,dispatched:false,supplierId:id(906),supplierName:'TEST 原批准加工厂',productionId:null,sampleTargetDate:null,canManage:false,canLogistics:false,canQc:false,canWarehouse:scenario!=='factory-readonly',canFollowup:false,tasks:[task],lines:[{lineId:id(905),poNumber:'TEST-PO-01',color:'深蓝',result:null,problem:'',treatment:''}],facts:[],checks:[]};
Object.assign(window,{taskContextFixture:{requests,scenario}});
window.fetch=async(input,init)=>{
 await new Promise(resolve=>window.setTimeout(resolve,0));const url=new URL(String(input),location.origin),method=init?.method??'GET';requests.push({path:url.pathname+url.search,method,body:init?.body?JSON.parse(String(init.body)):null});if(method!=='GET'&&scenario.startsWith('material-closure')){
 const body=JSON.parse(String(init?.body));const reject=(message:string)=>Response.json({error:{message}},{status:409});
 if(url.pathname.endsWith('/material-verification')){
  if(body.expectedVersion!==closure.materialVerification.version)return reject('TEST 核料记录已更新');
  if(body.entries.some((r:{usage:string;note:string;confirmedWith:string})=>r.usage==='unused'&&(!r.note||!r.confirmedWith)))return reject('本轮不使用的材料须记录与设计师确认的对象及说明');
  closure.materialVerification={...body,bulkRules:fixtureBulkRules(),version:body.expectedVersion+1,documentVersion:5,entries:body.entries.map((r:object)=>({...r,changedBy:'TEST 文员',changedAt:now,invalidated:[]}))};localStorage.setItem(bulkCount>0?`TEST-bulk-${bulkCount}`:'TEST-material-verification',JSON.stringify(closure.materialVerification));return Response.json({version:closure.materialVerification.version});
 }
 if(url.pathname.endsWith('/fabric-decisions')){const report=closure.fabricCases[0]!;if(body.expectedDecisionId!==report.decisionId)return reject('TEST 已有新决定');Object.assign(report,{decisionId:id(840),decision:{decision:body.decision,note:body.note},decidedAt:now,decidedBy:'TEST 总监',status:body.decision});localStorage.setItem('TEST-fabric-case',JSON.stringify(report));return Response.json({factId:id(840)});}
 if(url.pathname.endsWith('/check')){if(bulkCount>0)return reject('TEST 缺料／不符尚未解决，已保存输入但本次核料未完成');if(closure.materialVerification.entries.some(r=>r.usage==='pending'))return reject('尚有材料使用情况待文员确认');if(closure.fabricCases[0]!.status!=='允许使用')return reject('问题面料尚未允许使用，请供应链总监或 Root 在本页决定');task.state='completed';return Response.json({taskId:task.taskId,result:body.result});}
 }
 if(method!=='GET')return Response.json({error:{message:'TEST 只读事实场景，不办理真实业务'}},{status:403});
 if(url.pathname.endsWith('/auth/me'))return Response.json({status:'authorized',user:{id:id(1),displayName:'TEST 当前岗位',businessRoles:[scenario==='material-closure-director'?'production_management':scenario==='fabric-director'||scenario==='fabric-readonly'?'production_management':workerRole],capabilities:[],isRoot:scenario==='material-closure-root'}});
 if(url.pathname.endsWith('/execution')){if(scenario.startsWith('material-closure'))closure.materialVerification.bulkRules=fixtureBulkRules();return Response.json(execution);}
 if(url.pathname.endsWith('/development/rounds')){roundsReads++;if(scenario==='round-failure'&&roundsReads===1)return Response.json({error:{message:'TEST 本轮修改依据读取失败'}},{status:503});return Response.json(rounds);}
 if(url.pathname.endsWith('/development'))return Response.json({...sheet,...(url.searchParams.has('round')?{roundNumber:Number(url.searchParams.get('round'))}:{})});
 if(url.pathname.endsWith('/access/candidates'))return Response.json([{id:id(1),displayName:'TEST 张师傅',roles:[workerRole]}]);
 if(url.pathname.endsWith('/tasks/'+id(900)+'/documents'))return Response.json({development:{state:'published',id:id(901),version:2,label:'本次采用'},instruction:{state:'not_applicable'},budget:{state:'not_applicable'}});
 if(url.pathname.endsWith('/tasks/'+id(900)))return Response.json(task);
 if(url.pathname.endsWith('/tasks/'+id(900)+'/history'))return Response.json({events:[],revisions:[]});
 if(url.pathname.endsWith('/tasks'))return Response.json({items:[task]});
 if(url.pathname.endsWith('/bulk-preparation'))return Response.json(bulkSheet);
 if(url.pathname.endsWith('/factory-flow'))return Response.json(factorySheet);
 throw Error('Unexpected task context read: '+url.pathname);
};
void verifySession().then(()=>createRoot(document.getElementById('root')!).render(<AuthGate requiredAnyOf={['pattern_room_worker','production_management','development_clerk','sample_designer','warehouse_receiver'].map(requiredRole=>({requiredRole}))}><Shell active="digital-pattern" appearance="digital"><ProductionWorkspace>{scenario==='tasks-paused'?<DigitalTasksPanel options={{manage:false,customers:false,approveDelivery:false,create:false,actorId:id(1),roles:[workerRole]}} taskId={task.taskId}/>:factory?<FactoryFlowPanel orderId={id(902)} onClose={()=>undefined}/>:bulk?<BulkTaskWorkbench task={task} onClose={()=>undefined}/>:scenario==='material-records'?<DigitalDevelopmentPanel sourceId={id(901)} contained onClose={()=>undefined}/>:(scenario==='material-basis'||new URLSearchParams(location.search).has('fixtureBasis'))?<DevelopmentExecutionPanel sourceId={id(901)} taskId={task.taskId} workspace/>:<TaskWorkbenchSample task={task} onClose={()=>undefined}/>}</ProductionWorkspace></Shell></AuthGate>));
