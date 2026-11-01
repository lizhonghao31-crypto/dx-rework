// Actual editors with local synthetic HTTP. No real orders or identity changes.
import {createRoot} from 'react-dom/client';
import {DigitalQuotationPanel} from '../../apps/web/src/digital-quotation-panel.js';
import {DigitalBudgetPanel} from '../../apps/web/src/digital-budget-panel.js';
import {compareQuotationBudget,type QuotationSheet,type BudgetQuoteComparison} from '@dx-rework/contracts/digital-quotation';
import type {DigitalOrder} from '@dx-rework/contracts/digital-production';
import type {BudgetSheet} from '@dx-rework/contracts/digital-budget';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const mode=new URLSearchParams(location.search).get('mode')??'designer',resource={kind:'order' as const,id:id(1)};
const doc={fabricType:'针织',productCategory:'TEST 上衣',monthSeries:'P05',date:'2026-11-01',currency:'人民币' as const,freight:'0',cm:'0',salePrice:'99',outsourcingScope:'车缝',outsourcingUnitPrice:'8',imageAttachmentIds:[],rows:[{rowId:id(10),section:'主料' as const,category:'面料',name:'TEST 很长的面料名称用于验证表格内部滚动与完整显示',specification:'TEST 长规格40支平纹棉面料',unit:'米',supplier:'TEST 供应商',consumption:'1',unitPrice:'10'}]};
const assignment={rowId:id(10),technicalAssigneeId:id(3),priceAssigneeId:id(2),priceRole:'sample_designer' as const};
const quote:QuotationSheet={quoteId:id(5),resource,productionOrderId:id(1),sourceId:null,designStyleNo:'TEST-报价-01',designerId:id(2),customerCode:'PD',version:2,status:'draft',confirmedVersion:null,versions:[],document:mode==='technical'?null:structuredClone(doc),assignments:[assignment],rows:[{...doc.rows[0]!,unitPrice:mode==='technical'?null:'10',assignment,technicalAssigneeName:'TEST 纸样师',priceAssigneeName:'TEST 设计',canEditConsumption:mode==='technical',canEditPrice:mode==='designer',consumptionSource:null}],confirmation:null,canStructure:mode==='designer',canConfirm:mode==='designer',fullCost:mode!=='technical',budget:{state:'waiting_confirmation',version:null}};
const comparison:BudgetQuoteComparison={policy:'quote_v1',quoteId:id(5),quoteVersion:2,currentConfirmedVersion:2,state:'within_limit',reason:'预算总额不高于客户确认报价',budgetComparableTotal:'9',confirmedQuoteTotal:'20',amountScope:'per_piece',baseline:structuredClone(doc),confirmation:{expectedVersion:2,customerCode:'PD',customerConfirmedTotal:'20',amountScope:'per_piece',quantity:null,quantityUnit:'件',currency:'人民币',taxBasis:'excludes_tax',sourceKind:'explicit_customer_confirmation',sourceField:'customerConfirmedTotal',templateVersion:'online-quotation-v1',evidenceNote:'TEST 客户确认邮件',confirmedAt:'2026-01-01T00:00:00Z'}};
const budget:BudgetSheet={productionOrderId:id(1),version:1,status:'draft',document:{...structuredClone(doc),rows:[{...doc.rows[0]!,unitPrice:'9'}]},totals:null,canEdit:true,canPublish:true,canSubmitSourcing:false,sourcingCaseId:null,publishedAt:null,designerName:'TEST 设计',merchandiserName:'TEST 跟单',comparison};
const completed=new Map<string,QuotationSheet>();
const state={quote,budget,requests:[] as Array<{path:string;method:string;body:Record<string,unknown>|null;key:string|null}>,failNext:false,loseResponse:false,conflict:false};
Object.assign(window,{customerQuotationFixture:state});
window.fetch=async(input,init)=>{
 const path=new URL(String(input),location.origin).pathname,method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):null,key=new Headers(init?.headers).get('idempotency-key');state.requests.push({path,method,body,key});
 if(path.endsWith('/quotation/participants'))return Response.json({items:[{id:id(3),name:'TEST 纸样师',role:'pattern_room_worker'}]});
 if(path.includes('/quotation')){
  if(method==='GET')return Response.json(state.quote);
  if(key&&completed.has(key))return Response.json(completed.get(key));
  if(state.failNext){state.failNext=false;return Response.json({error:{message:'TEST 保存失败，输入保留',code:'VALIDATION_ERROR'}},{status:400});}
  if(state.conflict)return Response.json({error:{message:'TEST 报价版本已更新，输入保留',code:'QUOTATION_CONFLICT'}},{status:409});
  if(method==='PUT'){state.quote={...state.quote,version:state.quote.version+1,document:body.document,assignments:body.assignments};}
  if(path.includes('/rows/'))state.quote={...state.quote,version:state.quote.version+1,rows:state.quote.rows.map(r=>r.rowId===id(10)?{...r,consumption:body.consumption??r.consumption}:r)};
  if(path.endsWith('/confirm'))state.quote={...state.quote,status:'confirmed',confirmedVersion:state.quote.version,confirmation:body,canConfirm:false,budget:{state:'created',version:1}};
  state.quote={...state.quote,commandReceipt:{action:path.endsWith('/confirm')?'confirm':method==='PUT'?'save':`row:${path.split('/').at(-1)}`,appliedVersion:state.quote.version}};
  if(key)completed.set(key,structuredClone(state.quote));
  if(state.loseResponse){state.loseResponse=false;throw new TypeError('TEST response lost after commit');}
  return Response.json(state.quote);
 }
 if(path.endsWith('/budget')){if(method==='GET')return Response.json(state.budget);if(state.failNext){state.failNext=false;return Response.json({error:{message:'TEST 预算保存失败，输入保留',code:'VALIDATION_ERROR'}},{status:400});}state.budget={...state.budget,document:body.document,version:state.budget.version+1,comparison:{...comparison,...compareQuotationBudget(body.document,comparison.confirmation!,1)}};return Response.json(state.budget);}
 if(path.endsWith('/budget/publish')){state.budget={...state.budget,status:'published',canEdit:false,canPublish:false};return Response.json(state.budget);}
 throw Error(`Unexpected fixture request ${method} ${path}`);
};
const order={productionOrderId:id(1),designStyleNo:'TEST-报价-01',customerCode:'PD',productGroup:'男装',lines:[]} as unknown as DigitalOrder;
createRoot(document.getElementById('root')!).render(mode==='budget'?<DigitalBudgetPanel order={order} onClose={()=>undefined}/>:<DigitalQuotationPanel resource={resource}/>);
