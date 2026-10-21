// Actual commercial components; synthetic TEST HTTP only. Real guards are tested separately in PostgreSQL.
import {createRoot} from 'react-dom/client';
import {DigitalBudgetPanel} from '../../apps/web/src/digital-budget-panel.js';
import {ContractInformationRefresh} from '../../apps/web/src/contract-information-refresh.js';
import {BudgetDocumentSchema,calculateBudget,type BudgetSheet} from '@dx-rework/contracts/digital-budget';
import type {DigitalOrder} from '@dx-rework/contracts/digital-production';
import '@dx-rework/ui/tokens.css';
import '@dx-rework/ui/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/dialog-visual-system.css';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,mode=new URLSearchParams(location.search).get('mode')||'budget-save-lost',now='2026-10-20T00:00:00.000Z';
const order={productionOrderId:id(100),sourceId:id(101),version:1,designStyleNo:'TEST-COMMERCIAL',temporaryStyleNo:null,customerCode:'TEST',productGroup:'男装',primaryMerchandiserId:id(1),orderDate:'2026-10-20',contractDeliveryDate:'2026-12-20',lines:[]} as unknown as DigitalOrder;
const doc=BudgetDocumentSchema.parse({fabricType:'TEST梭织',productCategory:'TEST上衣',monthSeries:'TEST原输入',date:'2026-10-20',currency:'人民币',rows:[],freight:'1',cm:'2',salePrice:'10',outsourcingScope:'TEST车缝',outsourcingUnitPrice:'3',imageAttachmentIds:[]});
let sheet:BudgetSheet={productionOrderId:id(100),version:1,status:'draft',document:doc,totals:calculateBudget(doc),canEdit:true,canSubmitSourcing:false,sourcingCaseId:null,publishedAt:null,designerName:'TEST设计师',merchandiserName:'TEST跟单',versions:[]};
const contract={sourcingContractDocumentId:id(55),sourcingApprovalSnapshotId:id(6),contractNumber:'TEST-CONTRACT',contractVersion:2,templateVersion:1,status:'ready',missingFields:[],snapshotFingerprint:'a'.repeat(64),pdfAttachmentId:id(57),pdfSha256:'b'.repeat(64),failureReason:null,preparedAt:now,generatedAt:now,canSupplement:false,canRefreshInformation:true,canEditContent:false};
const preview={sourcingContractDocumentId:id(55),informationFingerprint:'a'.repeat(64),returned:false,changes:[{field:'address',before:'TEST旧址',after:'TEST新址'}],missingFields:mode==='contract-missing'?['address','bankAccount']:[]};
const requests:Array<{path:string;method:string;body:unknown;key:string|null}>=[],commands=new Map<string,{body:string;reply:unknown}>();let commits=0,failed=false,readFails=0;
const clock=Date.now.bind(Date);let offset=0;Date.now=()=>clock()+offset;
Object.assign(window,{commercialFixture:{requests,get commits(){return commits;},advance:()=>{offset+=24*3600*1000;}}});
window.fetch=async(input,init)=>{
 await new Promise(resolve=>setTimeout(resolve,0));const url=new URL(String(input),location.origin),path=url.pathname,method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):null,key=new Headers(init?.headers).get('idempotency-key');requests.push({path,method,body,key});
 if(path==='/TEST-reload-contract'){if(mode==='contract-refresh'&&readFails++===0)return Response.json({error:{message:'TEST读取失败'}},{status:503});return Response.json({ok:true});}
 if(method==='GET'&&path.endsWith('/contract/refresh'))return Response.json(preview);
 if(method==='GET'&&path.endsWith('/budget'))return Response.json(sheet);
 if(method==='GET')return Response.json({error:{message:'TEST未映射读取'}},{status:404});
 if(mode.endsWith('denied'))return Response.json({error:{code:'FORBIDDEN',message:'TEST仅原有权岗位可办理，请回本单查看负责岗位'}},{status:403});
 const scope=`${path}:${key}`,old=commands.get(scope);if(old){if(old.body!==JSON.stringify(body))return Response.json({error:{message:'TEST同键不同正文'}},{status:409});return Response.json(old.reply);}
 let reply:unknown;
 if(path.endsWith('/contract/refresh'))reply={item:contract};
 else if(method==='PUT'&&path.endsWith('/budget')){sheet={...sheet,version:sheet.version+1,status:'draft',document:body.document,totals:calculateBudget(body.document)};reply=sheet;}
 else if(method==='POST'&&path.endsWith('/budget/publish')){sheet={...sheet,status:'published',publishedAt:now};reply=sheet;}
 else return Response.json({error:{message:'TEST未映射写入'}},{status:403});
 commits++;commands.set(scope,{body:JSON.stringify(body),reply});
 const loseThis=path.endsWith('/contract/refresh')||!mode.startsWith('budget-publish')||path.endsWith('/publish');
 if(!failed&&mode!=='contract-refresh'&&loseThis){
  failed=true;if(mode.endsWith('malformed'))return Response.json({});if(mode.endsWith('408'))return Response.json({error:{message:'TEST回执超时'}},{status:408});throw new TypeError('TEST response lost after commit');
 }
 return Response.json(reply);
};
createRoot(document.getElementById('root')!).render(mode.startsWith('budget')?<DigitalBudgetPanel order={order} onClose={()=>undefined}/>:<ContractInformationRefresh caseId={id(100)} disabled={false} canEditContent={false} onUpdated={async()=>{const r=await fetch('/TEST-reload-contract');if(!r.ok)throw Error('TEST最新订单资料暂未读取');}}/>);
