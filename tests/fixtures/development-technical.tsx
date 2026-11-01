import {DevelopmentCycleSettings} from '../../apps/web/src/development-cycle-settings.js';
// Actual task workbench and controllers with synthetic HTTP only. Database invariants are tested separately.
import '../../apps/web/src/App.js';
import '@dx-rework/ui/tokens.css';
import '@dx-rework/ui/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/workflow-shell.css';
import '../../apps/web/src/dialog-visual-system.css';
import '../../apps/web/src/ui-polish.css';
import {createRoot} from 'react-dom/client';
import {Surface} from '@dx-rework/ui';
import {TaskWorkbenchSample} from '../../apps/web/src/task-workbench-sample.js';
import {DevelopmentExecutionPanel} from '../../apps/web/src/digital-development-execution-panel.js';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import type {DevelopmentTechnicalState,TechnicalArtifact,TechnicalArtifactBody} from '@dx-rework/contracts/digital-development-technical';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,mode=new URLSearchParams(location.search).get('mode')??'paper',at='2026-11-01T00:00:00Z';
const document:DevelopmentDocument={documentFormatVersion:2,sizeQuantities:[],template:'上衣',quantity:1,sampleSize:'',orderDate:'2026-11-01',returnDate:null,unit:'cm',sizes:[],measurements:[],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'TEST开发创建尺码选填；技术在本轮形成基码尺寸。',craft:'印花',washing:'免洗',materials:[{materialId:id(10),category:'主布',label:'主布A',supplier:'TEST',name:'TEST很长的面料名称用于验证内部表格滚动和完整显示',width:'150',weight:'200',composition:'棉',consumption:'',color:'黑',specification:'TEST40支平纹',quantity:'1',requiredThisRound:true,available:true,expectedDate:null}],files:[]};
const body:TechnicalArtifactBody={pltAttachmentIds:[id(60)],consumptionRows:[{materialId:id(10),unit:'米',consumption:'1.25'}],baseSizeTable:{unit:'cm',baseSize:'M',sizes:['S','M','L'],measurements:[{pointId:id(20),name:'胸围',values:['46','48','50'],tolerance:'±1',method:'平量'},{pointId:id(21),name:'衣长',values:['60','62','64'],tolerance:'±1',method:'后中量'}],gradingNote:'TEST技术部确认的本客户跳码规则，非通用算法。',templateRef:null},note:'TEST原成果说明',basedOnFinalComment:null};
const artifact:TechnicalArtifact={artifactSetId:id(30),version:1,sourceId:id(1),roundNumber:1,scopeRef:'整款',taskId:id(2),documentVersion:2,status:mode==='paper'?'draft':'published',body,createdBy:id(3),createdAt:at};
const technical:DevelopmentTechnicalState={enrolled:true,ruleVersion:'development-20261031.1',roundNumber:1,scopeRef:'整款',artifacts:[artifact],comments:mode==='review'?[{commentId:id(40),version:1,roundNumber:1,scopeRef:'整款',isFinal:true,decision:'approved',text:'TEST客户最终批复：按现有尺寸核对，尺寸不变也须确认沿用。',evidenceRefs:[],evidenceNote:'TEST客户邮件',customerCode:'PD',occurredAt:null,recordedAt:at,reviewTaskId:id(2)}]:[],reviews:mode==='review'?[{reviewId:id(41),version:1,taskId:id(2),roundNumber:1,scopeRef:'整款',finalCommentId:id(40),finalCommentVersion:1,state:'pending',decision:null,artifactSetId:null,artifactVersion:null,note:'',assigneeId:id(3),dueAt:'2026-11-02T00:00:00Z'}]:[],effective:{sourceId:id(1),roundNumber:1,scopeRef:'整款',revision:'TEST',state:mode==='review'?'pending_review':'pending_customer',reasonCodes:[],customerCode:'PD',finalCommentRef:null,reviewRef:null,artifactRef:{id:id(30),version:1}},cycle:{ruleVersion:'development-20261031.1',policyVersion:1,roundNumber:1,mode:'normal',publishedAt:at,completedAt:null,internalSeconds:7200,excludedSeconds:3600,allowedSeconds:604800,state:'running',precisionReasons:[],dueAt:'2026-11-08T01:00:00Z',urgentRevision:0,urgentState:'none'},canRecordComment:mode==='feedback',canMaintainTemplates:mode!=='feedback'&&mode!=='position',canRequestUrgent:false,canApproveUrgent:false,canTriagePatch:mode==='patch',patches:mode==='patch'?[{issueId:id(55),roundNumber:1,tailTaskId:id(2),note:'TEST局部补片或整件报废，技术主管据实判定',decision:null,workTaskId:null,nativeOrderId:id(50)}]:[],preparationBasis:null,materialDecisions:[]};
const task:DigitalTask={taskId:id(2),sourceId:id(1),orderId:null,taskKind:mode==='patch'?'development_tail_check':mode==='review'?'development_size_review':mode==='position'?'development_positioning':'development_pattern',label:mode==='review'?'大货尺寸复核':mode==='position'?'设计定位图':'纸样',routeVersion:1,occurrence:1,state:mode==='patch'?'completed':'ready',assigneeId:id(3),assigneeName:mode==='position'?'TEST设计':'TEST纸样师',requiredRole:mode==='position'?'sample_designer':'pattern_room_worker',enteredAt:at,completedAt:null,recordedAt:at,dueAt:'2026-11-02T00:00:00Z',warningAt:'2026-11-01T16:00:00Z',slaHours:24,policyVersion:1,timeQuality:'现场登记',blockedReason:null,paused:false,hasHandover:false,routeProgress:{applicable:10,completed:2,cancelled:0},canExecute:mode!=='feedback',canManage:false,canControl:false,canCorrect:false};
const sheet={sourceId:id(1),productionOrderId:null,designStyleNo:'TEST-开发-PR03',temporaryStyleNo:null,customerCode:'PD',developmentType:'头版',designerName:'TEST设计',version:2,status:'published',document,publishedAt:at,taskId:id(2),canEdit:mode==='feedback',canRevise:false,roundNumber:1,latestRoundNumber:1,materialEvents:[]};
const state={technical,sheet,tasks:[task],patternOrder:{orderId:id(50)},routeFacts:[],facts:[],dispatch:null,canDispatch:false,canReportFabric:false,canDecideFabric:false,qrAvailable:false,slaEnrolled:true,externalPatterns:[],unifiedArrangement:true};
const control={state,requests:[] as Array<{path:string;method:string;body:unknown;key:string|null}>,failNext:false,loseResponse:false,readFailNext:false,upload:null as {filename:string;mimeType:string;sizeBytes:number;sha256:string}|null};Object.assign(window,{technicalFixture:control});
const completed=new Map<string,unknown>();
let standard={version:1,values:{normalDays:7,urgentDays:5,sizeReviewHours:24,externalWashDays:3},scope:'new_sources',history:[{version:1,reason:'TEST批准初值'}]};
window.fetch=async(input,init)=>{
 const path=new URL(String(input),location.origin).pathname,method=init?.method??'GET',data=init?.body instanceof FormData?null:init?.body?JSON.parse(String(init.body)):null,key=new Headers(init?.headers).get('idempotency-key');control.requests.push({path,method,body:data,key});
 if(path.includes('/development-technical-settings')){
  if(method==='GET')return Response.json(standard);
  if(path.endsWith('/preview'))return Response.json({token:'TEST-preview',version:standard.version,scope:'new_sources',existingSourcesChanged:0,changes:[{key:'normalDays',before:7,after:data.values.normalDays}]});
  standard={...standard,version:standard.version+1,values:data.values};return Response.json({version:standard.version,scope:'new_sources',existingSourcesChanged:0});
 }
 if(path==='/TEST-opaque-upload')return new Response('',{status:200});
 if(path.endsWith('/upload-limits'))return Response.json({maxUploadBytes:1000000});
 if(path.endsWith('/upload-intents')){control.upload=data;return Response.json({attachmentId:id(61),objectKey:'TEST/opaque.plt',uploadMethod:'POST',uploadUrl:location.origin+'/TEST-opaque-upload',uploadFields:{key:'TEST/opaque.plt'},expiresAt:'2099-01-01T00:00:00Z'});}
 if(path.endsWith('/finalize'))return Response.json({attachmentId:id(61),filename:control.upload!.filename,mimeType:control.upload!.mimeType,sizeBytes:control.upload!.sizeBytes,sha256:control.upload!.sha256,status:'ready',createdAt:at});
 if(path.endsWith('/execution')&&method==='GET'){if(control.readFailNext){control.readFailNext=false;return Response.json({error:{message:'TEST读取失败'}},{status:503});}return Response.json(state);}
 if(path.endsWith('/development')&&method==='GET')return Response.json(sheet);
 if(path.endsWith('/rounds'))return Response.json({rounds:[],draft:null});
 if(path.endsWith('/amendment/history'))return Response.json({amendments:[]});
 if(path.endsWith('/access/candidates'))return Response.json([]);
 if(path.includes('/technical-size-templates')&&method==='GET')return Response.json({items:[{templateId:id(70),version:1,customerCode:'PD',body:{name:'TEST客户上衣模板',table:body.baseSizeTable,note:'TEST'}}]});
 if(path.includes('content-read'))return Response.json({ok:true});
 if(method==='POST'&&path.includes('/technical/')||path.endsWith('/complete')){
  if(key&&completed.has(key))return Response.json(completed.get(key));
  if(control.failNext){control.failNext=false;return Response.json({error:{code:'DEVELOPMENT_TECHNICAL_CONFLICT',message:'TEST资料已变版，输入保留'}},{status:409});}
  let result:unknown={taskId:id(2),state:'completed'};
  if(path.endsWith('/patch-decision')){technical.patches[0]!.decision=data.decision;result={issueId:id(55),version:2,decision:data.decision};}
  if(path.endsWith('/artifacts')){const next={...artifact,version:(technical.artifacts[0]?.version??0)+1,body:data.body,status:data.action==='publish'?'published' as const:'draft' as const};technical.artifacts.unshift(next);result={artifactSetId:next.artifactSetId,version:next.version,status:next.status};}
  if(path.endsWith('/size-review')){technical.reviews[0]!.state='completed';task.state='completed';technical.effective!.state='effective';}
  if(path.endsWith('/comments')){technical.comments.unshift({commentId:id(41),version:technical.comments.length+1,roundNumber:1,scopeRef:'整款',isFinal:data.isFinal,decision:data.decision,text:data.text,evidenceRefs:data.evidenceRefs,evidenceNote:data.evidenceNote,customerCode:'PD',occurredAt:null,recordedAt:at,reviewTaskId:data.isFinal?id(42):null});result={commentId:id(41),version:technical.comments.length,reviewTaskId:data.isFinal?id(42):null};}
  if(path.endsWith('/complete'))task.state='completed';
  if(key)completed.set(key,result);if(control.loseResponse){control.loseResponse=false;throw new TypeError('TEST已写入回执丢失');}return Response.json(result);
 }
 return Response.json({error:{message:`TEST未模拟接口 ${path}`}},{status:404});
};
createRoot(window.document.getElementById('root')!).render(<main className="dx-production-ui"><div className="pattern-orders digital-production"><Surface>{mode==='settings'?<DevelopmentCycleSettings/>:mode==='feedback'?<DevelopmentExecutionPanel sourceId={id(1)}/>:<TaskWorkbenchSample task={task} onClose={()=>undefined}/>}</Surface></div></main>);
