// Actual App route; synthetic read-only fixtures, no live samples or business writes.
import {createRoot} from 'react-dom/client';
import {App} from '../../apps/web/src/App.js';
import {verifySession} from '../../apps/web/src/auth.js';
import type {SampleView} from '@dx-rework/contracts';
import {SampleAnalysisQuerySchema} from '../../packages/contracts/src/sample-analysis.js';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/responsibility-determination.css';
import '../../apps/web/src/workflow-shell.css';
import '../../apps/web/src/dialog-visual-system.css';
import '../../apps/web/src/workflow-state-visual.css';
import '../../apps/web/src/ui-polish.css';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const batches=[{brand:'WILSON',month:'2026-09',count:8,price:1122.5},{brand:'ZARA',month:'2026-08',count:25,price:330.6},{brand:'Wilson 长名称测试品牌',month:'2026-01',count:10,price:761}];
const all=batches.flatMap((b,k)=>Array.from({length:b.count},(_,i)=>({sampleId:id(k*100+i+1),sampleCode:`TEST-${k}-${i}`,styleName:'秋季开发长名称样衣',styleNo:`STYLE-${i}`,status:'borrowed',purchaseDate:b.month+'-01',purchaser:{id:id(100),name:'测试采购人'},holder:{id:id(101),name:'测试持有人'},brand:b.brand,brandId:null,brandName:b.brand,brandVersion:null,department:'设计部',departmentId:null,departmentName:'设计部',departmentVersion:null,category:'外套',purchasePrice:b.price.toFixed(2),borrowedAt:null,heldDays:5,canOpenDetail:true})));
const params=new URLSearchParams(location.search),scenario=params.get('fixtureState')??'normal',root=params.get('fixtureRole')==='root',denied=params.get('fixtureRole')==='denied';
const requests:{path:string;method:string}[]=[];Object.assign(window,{sampleAmountFixture:{requests,scenario}});
const records:SampleView[]=Array.from({length:47},(_,n)=>({sampleId:id(n+1),sampleCode:`TEST-SAMPLE-${String(n+1).padStart(3,'0')}`,status:n<31?'borrowed':n<40?'in_stock':n<44?'return_pending':'sold',version:1,brand:'测试品牌',styleName:'TEST 秋季开发样衣',styleNo:`TEST-${n+1}`,category:'外套',color:'深蓝',size:'M',department:'设计一部',purchaseDate:'2026-09-01',purchaserUserId:id(100),purchaserName:'测试采购人',holderUserId:n<31||(n>=40&&n<44)?id(100):null,holderName:n<31||(n>=40&&n<44)?'测试持有人':null,purpose:'采购后直接开发/打板',borrowedAt:'2026-09-01T01:00:00Z',storageLocation:n>=31&&n<40?'样衣仓A-01':null,remark:'TEST 合成资料',createdAt:'2026-09-01T01:00:00Z',updatedAt:'2026-09-01T01:00:00Z',finance:{purchasePrice:'100.01',receiptAttachmentIds:[]}}));
window.fetch=async(input,init)=>{
 const u=new URL(String(input),location.origin),method=init?.method??'GET';requests.push({path:u.pathname+u.search,method});if(method!=='GET')return Response.json({error:{message:'TEST 只读隔离场景'}},{status:403});let data:unknown;
 if(u.pathname.endsWith('/auth/me'))data={status:'authorized',user:{id:id(100),displayName:root?'TEST Root':'TEST 样衣财务只读',isRoot:root,businessRoles:denied?[]:['sample_finance'],capabilities:denied?[]:['sample:view_basic','sample:view_finance']}};
 else if(u.pathname.endsWith('/samples/options'))data={brands:['测试品牌'],departments:['设计一部'],purchaseYears:[2026],people:[{userId:id(100),name:'测试持有人'}]};
 else if(u.pathname.endsWith('/attachments'))data={attachments:[]};
 else if(u.pathname.endsWith('/samples')){
  const page=Number(u.searchParams.get('page')??1),view=u.searchParams.get('view')??'borrowed',search=u.searchParams.get('search');const rows=records.filter(row=>(view==='managed'?row.status!=='sold':view==='pending'?row.status.endsWith('pending'):view==='disposed'?row.status==='sold':row.status===view)&&(!search||row.sampleCode.startsWith(search)||row.styleNo.startsWith(search)));
  data={items:rows.slice((page-1)*15,page*15),totalCount:rows.length,page,counts:{borrowed:31,inStock:9,pending:4}};
 }
 else if(u.pathname.endsWith('/indicator'))data={pendingCount:0};
 else if(u.pathname.endsWith('/amounts'))data={purchaseTotal:'24855.00',managedOriginalValue:'24855.00',disposedOriginalValue:'0.00',saleReceipts:'0.00',lossCompensation:'0.00'};
 else if(u.pathname.endsWith('/analysis')){
  if(scenario==='failure')return Response.json({error:{message:'TEST 样衣金额读取失败'}},{status:503});
  const q=SampleAnalysisQuerySchema.parse(Object.fromEntries(u.searchParams));
  const items=(scenario==='empty'?[]:all).filter(x=>(!q.purchaseFrom||x.purchaseDate>=q.purchaseFrom)&&(!q.purchaseTo||x.purchaseDate<=q.purchaseTo)&&(!q.brand||q.brand===x.brand)&&(!q.minPrice||Number(x.purchasePrice)>=Number(q.minPrice))&&(!q.maxPrice||Number(x.purchasePrice)<=Number(q.maxPrice))&&(!q.status||q.status===x.status)&&(!q.category||q.category===x.category)&&(!q.purchaserUserId||q.purchaserUserId===x.purchaser.id)&&(!q.holderUserId||q.holderUserId===x.holder.id)&&(!q.department||q.department===x.department));
  const total=items.reduce((sum,x)=>sum+Math.round(Number(x.purchasePrice)*100),0)/100;
  const groups=new Map<string,{key:string;person:{id:string;name:string}|null;dimension:{id:string;name:string}|null;count:number;cents:number}>();
  for(const row of items){const person=q.group==='purchaser'||q.group==='purchaser_brand'?row.purchaser:q.group==='holder'?row.holder:null;const dimension=q.group==='brand'||q.group==='purchaser_brand'?{id:'raw:'+row.brand,name:row.brand}:q.group==='department'?{id:'raw:'+row.department,name:row.department}:q.group==='category'?{id:row.category,name:row.category}:null;const key=(person?.id??'')+':'+(dimension?.id??'');const g=groups.get(key)??{key,person,dimension,count:0,cents:0};g.count++;g.cents+=Math.round(Number(row.purchasePrice)*100);groups.set(key,g);}
  const grouped=[...groups.values()].sort((a,b)=>b.cents-a.cents).map(({cents,...g})=>({...g,amount:(cents/100).toFixed(2)}));
  data={asOf:'2026-09-08T01:00:00Z',filters:q,coverage:{unclassifiedArchivedCount:0,excludedTestCount:0,formalArchivedCount:0,unmappedBrandCount:items.length,unmappedDepartmentCount:items.length,missingCategoryCount:0},summary:{purchaseCount:items.length,purchaseAmount:total.toFixed(2),purchaserCount:items.length?1:0,averagePrice:(items.length?total/items.length:0).toFixed(2),legacyScopeAmount:total.toFixed(2),heldCount:items.length,heldAmount:total.toFixed(2),heldOver90Days:0,initialCustodyCount:0,borrowCount:0,returnCount:0,saleReceipts:'0.00',confirmedLossCompensation:'0.00',disposalCount:0},trend:batches.filter(b=>items.some(x=>x.brand===b.brand)).map(b=>({month:b.month,count:items.filter(x=>x.brand===b.brand).length,amount:(items.filter(x=>x.brand===b.brand).reduce((sum,x)=>sum+Math.round(Number(x.purchasePrice)*100),0)/100).toFixed(2)})).sort((a,b)=>a.month.localeCompare(b.month)),groups:grouped,groupTotal:grouped.length,groupPage:q.groupPage,disposals:[],items:items.slice((q.page-1)*15,q.page*15),page:q.page,totalCount:items.length,options:{people:[{id:id(100),name:'测试采购人'},{id:id(101),name:'测试持有人'}],brands:batches.map(b=>({id:'raw:'+b.brand,name:b.brand})),departments:[{id:'raw:设计部',name:'设计部'}],categories:['外套']},archiveReview:{count:0,amount:'0.00'}};
 }else throw Error('Unexpected sample fixture read: '+u.pathname);
 return new Response(JSON.stringify(data),{headers:{'content-type':'application/json','x-dx-rework-actor-id':id(100)}});
};
void verifySession().then(()=>createRoot(document.getElementById('root')!).render(<App/>));
