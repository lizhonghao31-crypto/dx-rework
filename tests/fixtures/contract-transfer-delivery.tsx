// Actual page; every request is intercepted with isolated TEST data.
import { createRoot } from 'react-dom/client';
import { SourcingCaseSummarySchema, CONTRACT_TERM_LABELS,calculateSourcingTotalExact } from '@dx-rework/contracts';
import { SourcingWorkspacePage } from '../../apps/web/src/sourcing-workspace-page.js';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/workflow-shell.css';
import '../../apps/web/src/dialog-visual-system.css';
import '../../apps/web/src/workflow-state-visual.css';
import '../../apps/web/src/ui-polish.css';
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const now='2026-10-13T00:00:00.000Z',params=new URLSearchParams(location.search);
const cycle=params.get('cycle')==='1';
const role=params.get('role') ?? 'root', reviewed=params.get('reviewed')==='1';
const roles=role==='root'?['root_superuser']:role==='management'?['production_management']:role==='owner'?['owner_group']:['order_merchandiser'];
const capabilities=['sourcing:view','supplier_contract_data:read','sourcing:inquiry:create','sourcing:contract:record',
  ...(role==='management'?['sourcing:decision:record','sourcing:factory_change:verify']:role==='owner'?['sourcing:owner:approve']:['sourcing:factory_change:request'])];
const lines=[{position:1,styleNo:'TEST-CONTRACT-TRANSFER',alternateStyleNo:null,color:'蓝',quantity:2020,unitPrice:'15.5',totalAmount:'31310'}];
let item=SourcingCaseSummarySchema.parse({
  sourcingCaseId:id(100),erpOrderId:'TEST-100',erpOrderNo:'TEST-CONTRACT-100',styleNo:'TEST-CONTRACT-TRANSFER',laneKey:'garment_processing',
  gender:'女装',styleName:'TEST-交期',orderQuantity:2020,lineItems:lines.map(line=>({position:line.position,styleNo:line.styleNo,alternateStyleNo:null,color:line.color,quantity:line.quantity,externalUnitPrice:line.unitPrice,legacy:false})),
  daxingUnitPrice:'8',estimatedCutPieceSendDate:'2026-10-04',deliveryDate:'2026-10-22',processDescription:null,processes:['TEST-车缝'],
  status:'pending_finance_reconciliation',version:6,createdBy:id(1),createdAt:now,updatedAt:now,
  ieQuote:{sourcingIeQuoteId:id(2),quoteVersion:1,unitPrice:'15.5',quantity:2020,totalAmount:'31310',linePrices:lines.map(({position,quantity,unitPrice,totalAmount})=>({position,quantity,unitPrice,totalAmount})),quoteReason:'TEST',quotedBy:id(1),quotedAt:now},
  decision:{sourcingDecisionId:id(3),decisionVersion:2,sourceType:'factory_change',sourceIeQuoteId:null,supersedesDecisionId:id(2),supplierId:id(4),supplierCode:'TEST-OLD',supplierName:'TEST原工厂',unitPrice:'15.5',quantity:2020,totalAmount:'31310',linePrices:lines.map(({position,quantity,unitPrice,totalAmount})=>({position,quantity,unitPrice,totalAmount})),decisionReason:'TEST',decidedBy:id(1),decidedAt:now},
  ownerDecision:null,
  approvalSnapshot:{sourcingApprovalSnapshotId:id(6),sourcingDecisionId:id(3),decisionVersion:2,supplierId:id(4),supplierCode:'TEST-OLD',supplierName:'TEST原工厂',quantity:2020,totalAmount:'31310',estimatedCutPieceSendDate:'2026-10-04',deliveryDate:'2026-10-22',processes:['TEST-车缝'],linePrices:lines,approvedBy:id(1),approvedAt:now},
  contractReturnMonitoring:true,contractReturnStatus:cycle?'pending':'returned_late',contractReturnOverdueHours:cycle?0:61,
});
const contractDocument={sourcingContractDocumentId:id(55),sourcingApprovalSnapshotId:id(6),contractNumber:'TEST-CONTRACT-V7',contractVersion:7,templateVersion:4,status:'ready',missingFields:[],snapshotFingerprint:'a'.repeat(64),pdfAttachmentId:id(57),pdfSha256:'b'.repeat(64),failureReason:null,preparedAt:now,generatedAt:now,canSupplement:false,canRefreshInformation:role==='root',canEditContent:role==='root'&&!reviewed};
const content={contractTitle:'TEST合同',contractNumber:'TEST-CONTRACT-V7',contractDate:'2026-10-13',partyAName:'TEST甲方',partyAAddress:'TEST地址',partyARepresentative:'TEST',partyASigningDate:'',partyBSigningDate:'',partyBName:'TEST原工厂',partyBAddress:'TEST地址',partyBRepresentative:'TEST',payeeName:'TEST',bankAccount:'TEST',bankName:'TEST',signingPlace:'TEST',gender:'女装',styleName:'TEST交期',estimatedCutPieceSendDate:'2026-10-04',deliveryDate:'2026-10-22',processes:['TEST-车缝'],lines,totalQuantity:2020,totalAmount:'31310',terms:Object.fromEntries(Object.keys(CONTRACT_TERM_LABELS).map(key=>[key,'TEST条款']))};
let priceRequest:Record<string,unknown>|null=params.get('pricePending')==='1'?{priceRequestId:id(88),baseDecisionId:id(3),baseDocumentId:id(55),unitPrice:'16',reason:'TEST待审批',requestedBy:id(1),requestedAt:now,requiresOwnerApproval:true,status:'pending',basisChanged:false}:null;
const requests:unknown[]=[];
let transferAttempts=0, renderedCaseId=id(100);
Object.assign(window,{contractTransferRequests:requests});
window.fetch=async(input,init)=>{
  const path=String(input),method=init?.method ?? 'GET',body=typeof init?.body==='string'?JSON.parse(init.body):null;
  requests.push({path,method,body,key:new Headers(init?.headers).get('idempotency-key')});
  if(method==='POST'&&path.includes('/price-reapplications')){
    if(path.endsWith('/decision'))priceRequest={...priceRequest,status:body.decision};
    else {
      priceRequest={priceRequestId:id(88),baseDecisionId:body.expectedDecisionId,baseDocumentId:body.expectedContractDocumentId,unitPrice:body.unitPrice,reason:body.changeReason,requestedBy:id(1),requestedAt:now,requiresOwnerApproval:Number(body.unitPrice)>15.5,status:Number(body.unitPrice)>15.5?'pending':'approved',basisChanged:false};
      if(Number(body.unitPrice)<=15.5)item={...item,version:item.version+1,decision:{...item.decision!,sourceType:'price_reapplication',unitPrice:body.unitPrice,totalAmount:calculateSourcingTotalExact(body.unitPrice,2020),linePrices:item.decision!.linePrices.map(line=>({...line,unitPrice:body.unitPrice,totalAmount:calculateSourcingTotalExact(body.unitPrice,line.quantity)}))}};
    }
    return Response.json(item);
  }
  if(method==='POST'&&path.includes('/factory-changes')){
    if(params.get('transferFailure')==='1'&&transferAttempts++===0){
      await new Promise<void>(resolve=>Object.assign(window,{releaseTransferFailure:resolve}));
      return Response.json({error:{code:'INVALID_STATE_TRANSITION',message:'TEST-转厂数量与当前订单数量不一致',requestId:'TEST-transfer-conflict-1'}},{status:409});
    }
    item={...item,deliveryDate:body.deliveryDate ?? item.deliveryDate,decision:{...item.decision!,supplierId:body.supplierId,supplierName:'TEST新工厂'},approvalSnapshot:{...item.approvalSnapshot!,deliveryDate:body.deliveryDate ?? item.deliveryDate}};
    return Response.json(item);
  }
  if(method!=='GET')return Response.json({error:{message:'TEST-only unexpected mutation'}},{status:403});
  if(path.endsWith('auth/me'))return Response.json({status:'authorized',user:{id:id(1),displayName:'TEST-'+role,isRoot:role==='root',businessRoles:roles,capabilities,readOnlyModules:params.get('readonly')==='1'?['sourcing']:[]}});
  if(path.endsWith('/contract/content'))return Response.json({sourcingContractDocumentId:id(55),informationFingerprint:'a'.repeat(64),content});
  if(path.endsWith('/contract/refresh'))return Response.json({sourcingContractDocumentId:id(55),informationFingerprint:'a'.repeat(64),returned:true,changes:[],missingFields:[]});
  if(path.endsWith('/attachments')||path.endsWith('/timeline'))return Response.json({items:[]});
  if(path.endsWith('/factories'))return Response.json({items:[{supplierId:id(4),supplierCode:'TEST-OLD',supplierName:'TEST原工厂'},{supplierId:id(5),supplierCode:'TEST-NEW',supplierName:'TEST新工厂'}]});
  if(path.endsWith('/price-reapplications/current'))return Response.json({item:priceRequest});
  if(path.endsWith('/factory-changes/current'))return Response.json({item:null});
  if(path.endsWith('/contract'))return Response.json({item:contractDocument});
  if(path.endsWith('/contract-return'))return Response.json({contractReturnCycleId:cycle?id(6):null,contractReturnMonitoring:true,contractReturnStatus:cycle?'pending':'returned_late',contractGeneratedAt:now,contractReturnDueAt:now,contractReturnedAt:cycle?null:now,contractReturnOverdueHours:cycle?0:61,uploadedByName:cycle?null:'TEST跟单',canUpload:true,uploadedFileCount:cycle?0:1,uploadedTotalBytes:cycle?0:128,currentContractReturned:false,currentContractDocumentId:id(55),signedContractDocumentId:id(54),signedContractVersion:6,signedContractNumber:'TEST-V6',attachments:[{attachmentId:id(58),filename:'TEST-signed.pdf',mimeType:'application/pdf',sizeBytes:128}],history:[]});
  if(path.endsWith('/dispatch'))return Response.json({item:null,canDispatch:false});
  if(path.endsWith('/cases/'+renderedCaseId))return Response.json({...item,sourcingCaseId:renderedCaseId});
  if(path.includes('master-data/crafts'))return Response.json([]);
  return Response.json({error:{message:'TEST route not mapped: '+path}},{status:404});
};
const root=createRoot(document.getElementById('root')!);
const renderCase=(number=100)=>{renderedCaseId=id(number);root.render(<SourcingWorkspacePage view="detail" sourcingCaseId={renderedCaseId}/>);};
Object.assign(window,{showTransferFixtureCase:renderCase});
renderCase();
