// Real controls/pages; every request below is synthetic. Nested legacy markup is a host sentinel.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SearchSelect,SearchableSelect} from '../../apps/web/src/search-select.js';
import {PatternOrderForm} from '../../apps/web/src/pattern-order-form.js';
import {DigitalBudgetPanel} from '../../apps/web/src/digital-budget-panel.js';
import {DevelopmentCreateForm} from '../../apps/web/src/digital-development-create-form.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {DigitalOrderCreateSchema} from '@dx-rework/contracts/digital-production';
import {InsetField} from '@dx-rework/ui';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/ui-polish.css';
import '../../apps/web/src/pattern-room.css';
import '../../apps/web/src/responsibility-determination.css';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,now='2026-10-17T00:00:00Z';
const requests:{path:string;method:string}[]=[];Object.assign(window,{controlLayoutFixture:{requests}});
const order={...DigitalOrderCreateSchema.parse({customerCode:'TEST',productGroup:'男装',designStyleNo:'TEST-CONTROLS',orderDate:'2026-10-17',lines:[{color:'黑',sizes:[{size:'M',quantity:100}],customerWarehouseArrivalDate:'2099-12-31'}]}),productionOrderId:id(5),sourceId:id(2),createdBy:id(3),createdAt:now,version:1,lines:[{lineId:id(6),color:'黑',colorForeign:null,poNumber:'TEST-PO',formalStyleNo:'TEST-PO',temporaryStyleNo:null,deliveryDate:'2099-12-31',sizes:[{size:'M',quantity:100}]}]};
window.fetch=async(input,init)=>{const path=String(input),method=init?.method??'GET';requests.push({path,method});if(method!=='GET')throw Error('No writes in control layout fixture');
 if(path.endsWith('/category-options'))return Response.json([{priceId:id(4),name:'TEST 短袖上衣',unit:'件'}]);
 if(path.includes('/quote')||path.endsWith('/hourly-quote'))return Response.json({priceId:id(4),name:'TEST 价格',unit:'小时',amount:'10.000',version:1});
 if(path.includes('misc-associations?'))return Response.json([]);
 if(path.endsWith('/budget'))return Response.json({productionOrderId:id(5),version:0,versions:[],status:'draft',document:null,canEdit:true,canSubmitSourcing:false,totals:null,sourcingCaseId:null,publishedAt:null});
 if(path.endsWith('/development'))return Response.json({sourceId:id(2),designStyleNo:'TEST-CONTROLS',version:0,status:'draft',document:initialDevelopmentDocument(),canEdit:true});
 return Response.json({error:{message:'Unmapped TEST read'}},{status:404});};
function Controls(){const [value,setValue]=useState('');return <main style={{padding:16,maxWidth:900}}><section aria-label="嵌套工序与责任方宿主哨兵"><label className="dx-field"><span>返工工序</span><span className="dx-field__control search-select-control"><SearchSelect ariaLabel="返工工序" value={value} options={[{value:'one',label:'TEST 车缝'},{value:'two',label:'TEST 整烫'}]} placeholder="选择工序" onChange={setValue}/></span></label><output>{value}</output></section><section aria-label="独立搜索与普通字段哨兵"><label>独立品类<SearchableSelect aria-label="独立品类" required><option value="">请选择</option><option value="one">TEST 上衣</option></SearchableSelect></label><InsetField label="原普通价格字段" defaultValue="10"/></section></main>;}
const mode=new URLSearchParams(location.search).get('mode');
createRoot(document.getElementById('root')!).render(mode==='misc'?<main className="pattern-orders" style={{padding:16,maxWidth:1080}}><PatternOrderForm kind="misc" onSaved={()=>{}} onCancel={()=>{}}/></main>:mode==='budget'?<DigitalBudgetPanel order={order} onClose={()=>{}}/>:mode==='development'?<DevelopmentCreateForm intent="development" customers={[]} serverToday="2026-10-17" onCancel={()=>{}} onCreated={()=>{}}/>:<Controls/>);
