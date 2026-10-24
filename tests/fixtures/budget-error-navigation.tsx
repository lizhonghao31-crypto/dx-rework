// Actual budget document owner and editor; isolated synthetic responses only.
import {createRoot} from 'react-dom/client';
import {OrderDocumentContainer} from '../../apps/web/src/order-document-container.js';
import {BUDGET_SECTIONS,type BudgetDocument} from '@dx-rework/contracts/digital-budget';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const document:BudgetDocument={fabricType:'',productCategory:'',monthSeries:'TEST未保存系列',date:null,currency:'人民币',freight:'',cm:'',salePrice:'',outsourcingScope:'',outsourcingUnitPrice:'',imageAttachmentIds:[],rows:BUDGET_SECTIONS.map((section,index)=>({rowId:id(index+10),section,category:'TEST分类',name:`TEST${section}`,specification:'TEST原规格',unit:'米',supplier:'TEST供应方',consumption:'',unitPrice:''}))};
const requests:{path:string;method:string}[]=[];Object.assign(window,{budgetNavigationFixture:{requests}});
window.fetch=async(input,init)=>{
 const path=new URL(String(input),location.origin).pathname,method=init?.method??'GET';requests.push({path,method});
 if(method!=='GET')throw Error('Invalid budget must not submit');
 if(path.includes('/document-directory/'))return Response.json({development:{state:'not_applicable'},instruction:{state:'not_applicable'},budget:{state:'available',id:id(1)}});
 if(path.endsWith('/budget'))return Response.json({productionOrderId:id(1),version:7,status:'draft',document,canEdit:true,canPublish:true,canSubmitSourcing:false,sourcingCaseId:null,publishedAt:null,designerName:'TEST设计师',merchandiserName:'TEST跟单',versions:[]});
 if(path.endsWith(`/orders/${id(1)}`))return Response.json({productionOrderId:id(1),designStyleNo:'TEST预算定位',customerCode:'TEST客户',productGroup:'男装',lines:[]});
 throw Error(`Unexpected request ${method} ${path}`);
};
createRoot(window.document.getElementById('root')!).render(<OrderDocumentContainer initial={{kind:'budget',id:id(1)}} onClose={()=>undefined}/>);
