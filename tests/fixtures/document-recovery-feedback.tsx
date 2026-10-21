import {createRoot} from 'react-dom/client';
import {ProductionInstructionPanel} from '../../apps/web/src/production-instruction-panel.js';
import {OrderClosurePanel} from '../../apps/web/src/order-closure-panel.js';
import {initialInstruction} from '@dx-rework/contracts/production-instruction';
import '@dx-rework/ui/tokens.css';import '@dx-rework/ui/components.css';import '../../apps/web/src/styles.css';import '../../apps/web/src/workflow-shell.css';import '../../apps/web/src/dialog-visual-system.css';import '../../apps/web/src/workflow-state-visual.css';import '../../apps/web/src/ui-polish.css';
const params=new URLSearchParams(location.search),view=params.get('view')??'instruction',mode=params.get('mode')??'lost',id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,now='2026-10-20T00:00:00.000Z';
const order={productionOrderId:id(1),sourceId:id(2),version:1,designStyleNo:'TEST-DOCUMENT',temporaryStyleNo:null,customerCode:'TEST',productGroup:'男装',primaryMerchandiserId:id(3),orderDate:'2026-10-20',contractDeliveryDate:'2099-12-01',lines:[]};
let instruction={order,currentOrderVersion:1,currentDeliveryDate:'2099-12-01',document:{...initialInstruction(),styleName:'TEST原款名',category:'TEST上衣',date:'2026-10-20',preshrink:'无需预缩'},version:1,publishedVersion:0,isPublishedSnapshot:false,sourceRound:1,latestSourceRound:1,versions:[],canEdit:true,cutStarted:false,merchandiserName:'TEST跟单',customerPoDates:[],dateRequests:[],canRequestDate:false,canApproveDate:false,printedBy:'TEST跟单'};
let closure={orderId:id(1),revision:'a'.repeat(64),productionId:null,stage:'等待回货与装箱',lines:[],outstanding:['TEST保留原业务未清事项'],canClose:true,canOpenReceiving:false,canOpenRework:false,canOpenWages:false,closed:null as null|{reason:string;outstanding:string[];closedBy:string;closedAt:string},shipmentStatus:'未知',customerReceiptStatus:'未知'};
const requests:Array<{path:string;method:string;key:string|null;body:unknown}>=[],commands=new Map<string,unknown>();let failed=false,commits=0,offset=0;const clock=Date.now.bind(Date);Date.now=()=>clock()+offset;
Object.assign(window,{documentRecoveryFixture:{requests,get commits(){return commits;},advance:()=>{offset+=24*3600*1000;}}});
window.fetch=async(input,init)=>{
 await new Promise(resolve=>setTimeout(resolve,0));const path=new URL(String(input),location.origin).pathname,method=init?.method??'GET',key=new Headers(init?.headers).get('idempotency-key'),body=init?.body?JSON.parse(String(init.body)):null;requests.push({path,method,key,body});
 if(method==='GET')return Response.json(view==='instruction'?instruction:closure);
 if(mode==='denied')return Response.json({error:{code:'FORBIDDEN',message:'TEST请原有权岗位在本单办理'}},{status:403});
 const scope=path+':'+key;if(commands.has(scope))return Response.json(commands.get(scope));let reply:unknown;
 if(view==='instruction'){instruction={...instruction,version:instruction.version+1,document:body.document};reply=instruction;}else{closure={...closure,revision:'b'.repeat(64),stage:'特殊结案',canClose:false,closed:{reason:body.reason.trim(),outstanding:closure.outstanding,closedBy:'TEST总监',closedAt:now}};reply=closure;}
 commits++;commands.set(scope,reply);if(!failed){failed=true;if(mode==='malformed')return Response.json({});throw new TypeError('TEST receipt lost after commit');}return Response.json(reply);
};
createRoot(document.getElementById('root')!).render(view==='instruction'?<ProductionInstructionPanel orderId={id(1)} onClose={()=>undefined}/>:<OrderClosurePanel orderId={id(1)} onClose={()=>undefined}/>);
