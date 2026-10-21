// Actual document components with synthetic source/round/version facts; every API is intercepted.
import '../../apps/web/src/App.js';
import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {ProductionWorkspace} from '@dx-rework/ui/production';
import {DevelopmentCreateForm,initialDevelopmentOrder} from '../../apps/web/src/digital-development-create-form.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {DigitalDevelopmentPanel} from '../../apps/web/src/digital-development-panel.js';
import {DigitalBudgetPanel} from '../../apps/web/src/digital-budget-panel.js';
import {ProductionInstructionPanel} from '../../apps/web/src/production-instruction-panel.js';
import {DevelopmentOrderArchive} from '../../apps/web/src/development-order-archive.js';
import {initialInstruction,type InstructionSheet} from '@dx-rework/contracts/production-instruction';
import {BudgetDocumentSchema,calculateBudget,type BudgetSheet} from '@dx-rework/contracts/digital-budget';
import type {DevelopmentSheet} from '@dx-rework/contracts/digital-development';
import type {DigitalOrder} from '@dx-rework/contracts/digital-production';
import type {DevelopmentWorkspaceItem} from '@dx-rework/contracts/digital-development-workspace';
import {Shell} from '../../apps/web/src/components.js';
import {AuthGate,verifySession} from '../../apps/web/src/auth.js';
import '@dx-rework/ui/tokens.css';
import '@dx-rework/ui/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/workflow-shell.css';
import '../../apps/web/src/dialog-visual-system.css';
import '../../apps/web/src/workflow-state-visual.css';
import '../../apps/web/src/ui-polish.css';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,scenario=new URLSearchParams(location.search).get('fixtureScenario')??'budget-draft',now='2026-10-17T00:00:00Z';
const requests:{path:string;method:string;body:unknown;key:string|null}[]=[],withOrder=scenario!=='create-development',count=Number(scenario.split('-').at(-1))||1,history=scenario==='instruction-history',cut=scenario.startsWith('instruction-cut');
const draft=initialDevelopmentOrder([]);draft.designStyleNo='TEST-DOC-开发款号';draft.customerCode=withOrder?'TEST':'';draft.orderDate='2026-10-17';draft.lines=[1,2].map(n=>({formalPoNo:`TEST-PO-${n}`,poNumber:null,formalStyleNo:null,temporaryStyleNo:null,color:n===1?'深蓝':'浅蓝',colorForeign:null,customerWarehouseArrivalDate:n===1?'2099-12-01':'2099-12-02',deliveryDate:null,sizes:[{size:'M',quantity:String(n*10)}]}));
const order={productionOrderId:id(100),sourceId:id(101),version:8,designStyleNo:draft.designStyleNo,temporaryStyleNo:null,customerCode:'TEST',productGroup:'男装',primaryMerchandiserId:id(1),orderDate:'2026-10-17',contractDeliveryDate:'2099-11-20',lines:draft.lines.map((line,i)=>({...line,lineId:id(200+i),position:i,poNumber:line.formalPoNo,formalStyleNo:line.formalPoNo,customerWarehouseArrivalDate:line.customerWarehouseArrivalDate,deliveryDate:line.customerWarehouseArrivalDate,sizes:[{size:'M',quantity:(i+1)*10}]}))} as DigitalOrder;
const document={...initialDevelopmentDocument(),patternCategoryId:id(400),quantity:2,sizeQuantities:[2],sampleSize:'M',orderDate:'2026-10-17',sizes:['M'],measurements:[{name:'胸围',values:['60']}],files:[{attachmentId:id(401),kind:'款图' as const}],customerOrderDraft:{withOrder,order:draft}};
let sheet:DevelopmentSheet={sourceId:id(101),productionOrderId:null,designStyleNo:draft.designStyleNo,temporaryStyleNo:null,customerCode:withOrder?'TEST':null,developmentType:'头版',designerName:'TEST 设计师',version:4,status:'draft',document,publishedAt:null,taskId:null,canEdit:true,materialEvents:[],roundNumber:2,latestRoundNumber:3};
if(scenario.startsWith('development-'))sheet={...sheet,status:'published',version:5,roundNumber:scenario==='development-history'?2:3,latestRoundNumber:3,canEdit:false};
const budgetDoc=BudgetDocumentSchema.parse({fabricType:'梭织',productCategory:'TEST风衣',monthSeries:'TEST',date:'2026-10-17',currency:'人民币',rows:[],freight:'1',cm:'2',salePrice:'10',outsourcingScope:'TEST原范围',outsourcingUnitPrice:'3',imageAttachmentIds:[]});
const budget:BudgetSheet={productionOrderId:id(100),version:scenario==='budget-history'?3:5,status:scenario==='budget-draft'?'draft':'published',document:budgetDoc,totals:calculateBudget(budgetDoc),canEdit:['budget-draft','budget-published'].includes(scenario),canSubmitSourcing:scenario==='budget-sourcing',sourcingCaseId:null,publishedAt:now,designerName:'TEST设计师',merchandiserName:'TEST主跟单',versions:[3,5]};
const images=scenario==='instruction-count-0'?[]:Array.from({length:scenario.startsWith('instruction-count')?count:1},(_,i)=>({attachmentId:id(500+i),kind:'款图' as const,description:`TEST 图片说明${i+1}`}));
const instruction:InstructionSheet={order,currentOrderVersion:8,currentDeliveryDate:'2099-11-20',document:{...initialInstruction(),styleName:'TEST风衣',category:'风衣',date:'2026-10-17',sizes:['M'],preshrink:'无需预缩',images,measurements:[{id:id(600),name:'胸围',tolerance:'1/4',method:'TEST原量法',values:['60']}]},version:history?4:7,publishedVersion:history?4:7,isPublishedSnapshot:history||cut,sourceRound:history?1:2,latestSourceRound:3,versions:[4,7],canEdit:!history&&!cut,cutStarted:cut,merchandiserName:'TEST主跟单',customerPoDates:order.lines.map((line,i)=>({lineId:line.lineId,poNumber:line.poNumber,color:line.color,date:`2099-12-${i===0?'20':'21'}`,registeredDate:line.customerWarehouseArrivalDate??null,version:2,source:'approved_customer_change',factoryDate:'2099-12-10'})),dateRequests:[{requestId:id(700),source:'po',oldDate:'2099-12-01',date:'2099-12-20',reason:'TEST原客户变更',status:'待批准',requestedBy:'TEST主跟单',requestedAt:now,decidedBy:null,decidedAt:null,changes:[{lineId:id(200),poNumber:'TEST-PO-1',color:'深蓝',oldDate:'2099-12-01',date:'2099-12-20',expectedVersion:2}],approvalBlockedReason:null}],canRequestDate:scenario==='instruction-cut-primary',canApproveDate:scenario==='instruction-cut-director',printedBy:'TEST打印人'};
const fixture={requests,confirmAttempts:0,created:[] as {sourceId:string;orderId:string|null}[]};Object.assign(window,{documentSemanticsFixture:fixture});
window.fetch=async(input,init)=>{
 await new Promise(resolve=>window.setTimeout(resolve,0));const url=new URL(String(input),location.origin),method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):null,key=new Headers(init?.headers).get('idempotency-key');requests.push({path:url.pathname+url.search,method,body,key});
 if(url.pathname.endsWith('/auth/me'))return Response.json({status:'authorized',user:{id:id(1),displayName:'TEST当前岗位',businessRoles:[scenario==='instruction-cut-director'?'production_management':scenario.startsWith('instruction')||scenario==='budget-sourcing'?'order_merchandiser':'sample_designer'],capabilities:[],isRoot:false}});
 if(url.pathname.endsWith('/category-options'))return Response.json([{priceId:id(400),name:'TEST原打板品类',unit:'件'}]);
 if(url.pathname.endsWith('/quote'))return Response.json({priceId:id(400),name:'TEST原打板品类',unit:'件',amount:'40.000',version:1});
 if(url.pathname.endsWith('/options'))return Response.json({serverToday:'2026-10-17',minimumInitialCustomerDate:'2026-11-17'});
 if(url.pathname.endsWith('/development/publish')&&method==='POST'){sheet={...sheet,status:'published',publishedAt:now,taskId:id(900)};return Response.json(sheet);}
 if(url.pathname.endsWith('/development/rounds'))return Response.json({rounds:[{roundNumber:2,origin:'内部发现',customerComment:'',internalProblem:'TEST原问题',explanation:'TEST原修改',affectedNodes:['工艺'],inherited:{}}],draft:null});
 if(url.pathname.endsWith('/development')){if(method==='PUT')sheet={...sheet,version:sheet.version+1,document:body.document};return Response.json(sheet);}
 if(url.pathname.endsWith('/confirm')&&method==='POST'){fixture.confirmAttempts++;if(fixture.confirmAttempts===1)return Response.json({error:{message:'TEST 客户订单回执暂不可用'}},{status:503});return Response.json(order);}
 if(method!=='GET'&&url.pathname.includes('/date-requests'))return Response.json(instruction);
 if(method!=='GET')return Response.json({error:{message:'TEST拒绝未映射业务写入'}},{status:403});
 if(url.pathname.endsWith('/budget'))return Response.json(budget);
 if(url.pathname.endsWith('/instruction'))return Response.json(instruction);
 throw Error('Unexpected document semantics request: '+method+' '+url.pathname);
};
function Fixture(){const [finished,setFinished]=useState(false);return finished?<p>TEST 已返回原档案</p>:scenario.startsWith('create')?<DevelopmentCreateForm contained intent={withOrder?'certain_order':'development'} existingDraft={sheet} customers={[{code:'TEST',name:'TEST客户',productGroups:['男装'],defaultMerchandiserId:id(1),defaultMerchandiserName:'TEST主跟单'}]} minimumDate="2026-11-17" serverToday="2026-10-17" onCancel={()=>undefined} onCreated={(sourceId,orderId)=>{fixture.created.push({sourceId,orderId});setFinished(true);}}/>:scenario.startsWith('development-')?<DigitalDevelopmentPanel sourceId={id(101)} initialRound={scenario==='development-history'?2:undefined} onClose={()=>undefined}/>:scenario.startsWith('budget')?<DigitalBudgetPanel order={order} initialVersion={scenario==='budget-history'?3:undefined} onClose={()=>undefined}/>:scenario==='archive'?<DevelopmentOrderArchive item={{view:'ordered',canConfirm:false,journey:{id:id(101),sourceId:id(101),orderId:id(100),designStyleNo:draft.designStyleNo,customer:'TEST',designer:'TEST设计师',selectedRound:2,adoptedRound:1,createdAt:now,lines:order.lines.map(line=>({id:line.lineId,formalStyleNo:line.formalStyleNo,po:line.poNumber,color:line.color,orderedQuantity:line.sizes[0]!.quantity})),poDeliveryDates:instruction.customerPoDates!.map(line=>({lineId:line.lineId,poNumber:line.poNumber,color:line.color,customerWarehouseArrivalDate:line.date,factoryDeliveryDate:line.factoryDate,sampleTargetDate:'2099-12-10'}))}} as DevelopmentWorkspaceItem} sheet={{...sheet,status:'published'}} order={order} sheetError={undefined} orderError={undefined} sourceUrl="/ui/digital-production?development=TEST&round=2" canConfirm={false} onConfirm={()=>undefined}/>:<ProductionInstructionPanel orderId={id(100)} initialVersion={history?4:undefined} onClose={()=>undefined}/>;}
void verifySession().then(()=>createRoot(window.document.getElementById('root')!).render(<AuthGate requiredAnyOf={['sample_designer','order_merchandiser','production_management'].map(requiredRole=>({requiredRole}))}><Shell active="digital-pattern" appearance="digital"><ProductionWorkspace><Fixture/></ProductionWorkspace></Shell></AuthGate>));
