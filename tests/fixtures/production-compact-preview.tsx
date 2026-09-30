// Isolated display and local-motion fixture; all business writes are rejected.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ProductionDashboardPage} from '../../apps/web/src/production-dashboard-page.js';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/workflow-shell.css';
import '../../apps/web/src/dialog-visual-system.css';
import '../../apps/web/src/workflow-state-visual.css';
import '../../apps/web/src/ui-polish.css';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const supplierName='合成测试 · 达兴长名称服装加工供应商';
const items=['normal','high_risk','stale'].map((progressState,k)=>({order:{productionOrderId:id(k+1),firstStyleNo:'TEST-AUTUMN-LONG-STYLE-'+k,supplierId:id(10),supplierName,status:'in_production',quantity:12345,deliveryDate:'2026-09-20',lines:Array.from({length:5},(_,i)=>({position:i+1,styleNo:'TEST-'+i,color:'蓝色',quantity:2469,completedQuantity:500})),sourceCaseArchived:false},progress:{productionProgress:20+k*5,timeProgress:60,firstReportedOn:'2026-09-01',lastUpdatedAt:'2026-09-07T01:00:00Z',completedQuantity:2500,progressState,frozen:false,attention:k>0,daysWithoutUpdate:k===2?3:0}}));
const events=Array.from({length:4},(_,k)=>({id:'event-'+k,productionOrderId:id(1),firstStyleNo:'TEST-AUTUMN-LONG-STYLE-'+k,supplierName,kind:'report',quantity:1234,businessDate:'2026-09-07',recordedAt:'2026-09-07T01:00:00Z'}));
window.fetch=async(input,init)=>{const u=new URL(String(input),location.origin);if(init?.method&&init.method!=='GET')return new Response('{}',{status:403});let data:unknown;
 if(u.pathname.endsWith('/indicator'))data={pendingCount:0};
 else if(u.pathname.endsWith('/pilots'))data={suppliers:[{supplierId:id(10),supplierName,enabled:false}]};
 else if(u.pathname.endsWith('/production-dashboard')){const q=u.searchParams.get('q')??'';const filtered=items.filter(x=>x.order.firstStyleNo.includes(q)||supplierName.includes(q));data={asOf:new Date().toISOString(),items:filtered,page:1,totalCount:filtered.length,counts:{attention:2,inProduction:3,completed:0,shipped:0},suppliers:[{supplierId:id(10),supplierName}],events};}
 else return new Response('{}',{status:404});
 return new Response(JSON.stringify(data),{headers:{'content-type':'application/json','x-dx-rework-actor-id':id(100)}});
};
createRoot(document.getElementById('root')!).render(<ProductionDashboardPage/>);
