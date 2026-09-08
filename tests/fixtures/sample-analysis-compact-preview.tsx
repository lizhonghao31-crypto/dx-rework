// Offline fixture with real analysis page, query schemas and navigation reducer.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {SampleAnalysisPage} from '../../apps/web/src/sample-analysis-page.js';
import {SampleAnalysisQuerySchema} from '../../packages/contracts/src/sample-analysis.js';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/workflow-shell.css';
import '../../apps/web/src/dialog-visual-system.css';
import '../../apps/web/src/workflow-state-visual.css';
import '../../apps/web/src/ui-polish.css';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const batches=[{brand:'WILSON',month:'2026-09',count:8,price:1122.5},{brand:'ZARA',month:'2026-08',count:25,price:330.6},{brand:'Wilson 长名称测试品牌',month:'2026-01',count:10,price:761}];
const all=batches.flatMap((b,k)=>Array.from({length:b.count},(_,i)=>({sampleId:id(k*100+i+1),sampleCode:`TEST-${k}-${i}`,styleName:'秋季开发长名称样衣',styleNo:`STYLE-${i}`,status:'borrowed',purchaseDate:b.month+'-01',purchaser:{id:id(100),name:'测试采购人'},holder:{id:id(101),name:'测试持有人'},brand:b.brand,brandId:null,brandName:b.brand,brandVersion:null,department:'设计部',departmentId:null,departmentName:'设计部',departmentVersion:null,category:'外套',purchasePrice:b.price.toFixed(2),borrowedAt:null,heldDays:5,canOpenDetail:true})));
window.fetch=async(input)=>{
 const u=new URL(String(input),location.origin);let data:unknown;
 if(u.pathname.endsWith('/indicator'))data={pendingCount:0};
 else if(u.pathname.endsWith('/amounts'))data={purchaseTotal:'24855.00',managedOriginalValue:'24855.00',disposedOriginalValue:'0.00',saleReceipts:'0.00',lossCompensation:'0.00'};
 else if(u.pathname.endsWith('/analysis')){
  const q=SampleAnalysisQuerySchema.parse(Object.fromEntries(u.searchParams));
  const items=all.filter(x=>(!q.purchaseFrom||x.purchaseDate>=q.purchaseFrom)&&(!q.purchaseTo||x.purchaseDate<=q.purchaseTo)&&(!q.brand||q.brand===x.brand));
  const total=items.reduce((sum,x)=>sum+Math.round(Number(x.purchasePrice)*100),0)/100;
  const grouped=batches.map(b=>({key:'raw:'+b.brand,person:null,dimension:{id:'raw:'+b.brand,name:b.brand},count:items.filter(x=>x.brand===b.brand).length,amount:items.filter(x=>x.brand===b.brand).reduce((sum,x)=>sum+Math.round(Number(x.purchasePrice)*100),0)/100})).filter(x=>x.count).sort((a,b)=>b.amount-a.amount).map(x=>({...x,amount:x.amount.toFixed(2)}));
  data={asOf:'2026-09-08T01:00:00Z',filters:q,coverage:{unclassifiedArchivedCount:0,excludedTestCount:0,formalArchivedCount:0,unmappedBrandCount:items.length,unmappedDepartmentCount:items.length,missingCategoryCount:0},summary:{purchaseCount:items.length,purchaseAmount:total.toFixed(2),purchaserCount:items.length?1:0,averagePrice:(items.length?total/items.length:0).toFixed(2),legacyScopeAmount:total.toFixed(2),heldCount:items.length,heldAmount:total.toFixed(2),heldOver90Days:0,initialCustodyCount:0,borrowCount:0,returnCount:0,saleReceipts:'0.00',confirmedLossCompensation:'0.00',disposalCount:0},trend:batches.filter(b=>items.some(x=>x.brand===b.brand)).map(b=>({month:b.month,count:items.filter(x=>x.brand===b.brand).length,amount:(b.count*b.price).toFixed(2)})).sort((a,b)=>a.month.localeCompare(b.month)),groups:grouped,groupTotal:grouped.length,groupPage:q.groupPage,disposals:[],items:items.slice((q.page-1)*15,q.page*15),page:q.page,totalCount:items.length,options:{people:[{id:id(100),name:'测试采购人'}],brands:batches.map(b=>({id:'raw:'+b.brand,name:b.brand})),departments:[{id:'raw:设计部',name:'设计部'}],categories:['外套']},archiveReview:{count:0,amount:'0.00'}};
 }else return new Response('{}',{status:404});
 return new Response(JSON.stringify(data),{headers:{'content-type':'application/json','x-dx-rework-actor-id':id(100)}});
};
createRoot(document.getElementById('root')!).render(<SampleAnalysisPage/>);
