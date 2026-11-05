// Synthetic TEST HTTP for the original directory and QC history components.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {JOURNEY_STAGES,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {CockpitDocuments} from '../../apps/web/src/cockpit-documents.js';
import {QcProductionProgressPanel} from '../../apps/web/src/qc-production-progress-panel.js';
import type {CockpitContext} from '../../apps/web/src/digital-journey-cockpit-model.js';
import '@dx-rework/ui/tokens.css';import '@dx-rework/ui/components.css';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,sid=id(1),oid=id(2),actor=id(7),aid=id(3),now='2026-11-03T00:00:00Z';
const params=new URLSearchParams(location.search),old=params.get('case')==='coexist',round=old?1:2;
const control={revoked:false,requests:[] as Array<{path:string;method:string}>,active:0,peak:0};Reflect.set(window,'p03Fixture',control);
const frame:OrderJourney={id:sid,sourceId:sid,orderId:oid,asOf:now,designStyleNo:'TEST-P03',temporaryStyleNo:null,customer:'TEST客户',category:null,designer:'TEST设计',styleName:null,merchandisers:[],orderNumbers:[],createdAt:now,deliveryDate:null,selectedRound:2,adoptedRound:round,sourceVersion:5,instructionVersion:6,lines:[],links:[],stages:JOURNEY_STAGES.map(s=>({...s,state:'active',nodes:[]})),progress:{development:null,bulk:null},hitReasons:[]};
const archive={productionId:id(20),factoryDecisionId:null,supplierName:'TEST旧厂 · 零报量',currentQuantity:0,records:[]};
window.fetch=async(input,init)=>{
 const url=new URL(String(input),location.origin),path=url.pathname.replace(/^\/api\//,''),method=init?.method??'GET';control.requests.push({path:path+url.search,method});
 if(method!=='GET')return Response.json({error:{message:'TEST本页只读'}},{status:403});
 const send=(data:unknown,status=200)=>Response.json(data,{status});
 if(path==='auth/me')return send({status:'authorized',user:{id:actor,displayName:'TEST设计与跟单读取',isRoot:false,businessRoles:['sample_designer','order_merchandiser'],capabilities:['digital_production:view']}});
 control.active++;control.peak=Math.max(control.peak,control.active);
 try{
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,8);init?.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));},{once:true});});
  if(path.endsWith('/instruction'))return send({order:{productionOrderId:oid},version:Number(url.searchParams.get('version')??7),publishedVersion:6,versions:[6,4],sourceRound:round,document:{images:[]}});
  if(path.endsWith('/bulk-preparation'))return send({orderId:oid,preparationId:null,sourceRound:2,adoptedRound:round,tasks:[],facts:[],instructionValid:false,publishedBasis:{instructionVersion:6,sourceId:control.revoked?null:sid,sourceRound:round,publishedAt:'2026-11-02T12:00:00Z',technicalArtifact:control.revoked?null:{id:aid,version:1,sourceId:sid,roundNumber:1,scopeRef:'整款'},technicalBasisState:control.revoked?'restricted':'recorded'}});
  if(path.endsWith('/development/rounds'))return control.revoked?send({error:{message:'TEST开发范围已撤回'}},403):send({rounds:[{roundNumber:2}],draft:{version:3,payload:{basedOnRound:2}}});
  if(path.endsWith('/development'))return control.revoked?send({error:{message:'TEST开发范围已撤回'}},403):send({sourceId:sid,roundNumber:2,version:5,status:'published',document:{files:[]}});
  if(path.includes('/technical/history')){
   if(control.revoked)return send({error:{message:'TEST原技术范围已撤回'}},403);
   const selected=Number(url.searchParams.get('version')??2),inherited=url.searchParams.has('adoptedArtifactId'),a={artifactSetId:aid,version:selected,sourceId:sid,roundNumber:inherited?1:Number(url.searchParams.get('roundNumber')??2),scopeRef:'整款',documentVersion:1,status:'published',createdAt:'2026-11-01T00:00:00Z',createdByName:'TEST原纸样师',...(inherited?{viaSourceId:sid,viaRoundNumber:2,inheritedAt:'2026-11-02T00:00:00Z'}:{})};
   return send({sourceId:sid,roundNumber:Number(url.searchParams.get('roundNumber')??2),scopeRef:'整款',items:[{...a,...(url.searchParams.has('view')?{}:{body:{pltAttachmentIds:[id(selected===1?30:31)],consumptionRows:[],baseSizeTable:{sizes:['M'],measurements:[],baseSize:'M',unit:'cm',gradingNote:'TEST原尺寸表'}}})}],nextBeforeVersion:null,effective:{state:'pending_review'},adoptedArtifact:{...a,version:2}});
  }
  if(path.endsWith('/qc-progress'))return send({viewerId:actor,orderId:oid,asOf:now,canManage:false,canRecord:false,paused:false,qcUserId:null,qcName:null,qualityLeadId:null,qualityLeadName:null,settingsVersion:0,executions:[{productionId:id(20),factoryDecisionId:id(21),supplierName:'TEST现厂',status:'in_production',scopeRevision:'a'.repeat(64),progressRevision:0,trackingId:null,trackingStartedAt:null,trackingBasis:null,clock:{state:'unknown',basis:'unknown',anchor:null,remindAt:null,escalateAt:null,windowKey:null,reason:'TEST监督起点待核'},lineClocks:[],windows:[],canRecord:false,lines:[{lineId:id(22),position:1,poNumber:'TEST-PO',color:'黑',quantity:1,completedQuantity:0}],records:[]}],archivedExecutions:[archive]});
  return send({error:{message:'TEST未提供本类原始记录'}},404);
 }finally{control.active--;}
};
function Fixture(){const [context,setContext]=useState<CockpitContext>({selected:sid});return <div className="digital-journey-cockpit" style={{padding:16}}><p>TEST模拟数据 · 原组件；不代表现场原件与部署</p>{params.get('view')==='qc'?<QcProductionProgressPanel orderId={oid} people={[]}/>:<CockpitDocuments order={frame} context={context} onChange={patch=>setContext(c=>({...c,...patch}))}/>}</div>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
