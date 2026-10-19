// Actual application and synthetic reads only; maintenance mutations remain blocked.
import {createRoot} from 'react-dom/client';
import {App} from '../../apps/web/src/App.js';
import {verifySession} from '../../apps/web/src/auth.js';
import type {SupplierProfile} from '../../apps/web/src/supplier-profile-draft.js';
import '@dx-rework/ui/tokens.css';
import '@dx-rework/ui/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/responsibility-determination.css';
import '../../apps/web/src/workflow-shell.css';
import '../../apps/web/src/dialog-visual-system.css';
import '../../apps/web/src/workflow-state-visual.css';
import '../../apps/web/src/ui-polish.css';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const params=new URLSearchParams(location.search),root=params.get('fixtureRole')==='root',scenario=params.get('fixtureState')??'normal',restricted=params.has('fixtureRestricted');
const records:SupplierProfile[]=Array.from({length:24},(_,i)=>({supplierId:id(i+1),supplierCode:`TEST-SUP-${String(i+1).padStart(3,'0')}`,supplierType:i%4===0?'factory':i%4===1?'embroidery_washing':i%4===2?'fabric':'other',version:2,supplierName:`TEST 广州市秋冬服装长期合作供应商${i+1}（第一生产区）`,active:i!==2,notes:'TEST 合成资料，用于核对分组和原字段。'.repeat(6),contactPerson:'TEST 联系人',contactPhone:'020-00000000',address:'TEST 合成地址第一生产区第二栋第三车间',...(!restricted?{contractEntityName:'TEST 合成合同主体'.repeat(16),partyBRepresentative:'TEST 乙方代表',payeeName:'TEST 收款人',bankAccount:'TEST0123456789'.repeat(8),bankName:'TEST 合成开户行服装生产业务支行'}:{}),supportedCrafts:i%3?['车缝','整烫','压褶']:[],dailyCapacity:i===0?0:i===1?null:12800,contractDataMissing:i%3?[]:['bankName'],changeReason:'TEST 合成资料第二版',changedBy:id(100),changedAt:'2026-10-17T00:00:00Z'}));
if(params.has('fixtureLongName'))records[0]!.supplierName=('TEST 广东省达兴服装供应链长期合作制衣加工厂'.repeat(12)).slice(0,200);
const requests:{path:string;method:string}[]=[];Object.assign(window,{supplierLayoutFixture:{requests,scenario,restricted,root}});
window.fetch=async(input,init)=>{
 const path=String(input),method=init?.method??'GET',url=new URL(path,location.origin);requests.push({path,method});if(method!=='GET')return Response.json({error:{message:'隔离场景，未写入供应商资料'}},{status:403});
 if(url.pathname.endsWith('/auth/me'))return Response.json({status:'authorized',user:{id:id(100),displayName:root?'TEST Root':'TEST 目录只读跟单',isRoot:root,businessRoles:['order_merchandiser'],capabilities:['supplier_profile:read']}});
 if(url.pathname.endsWith('/master-data/suppliers'))return scenario==='list-failure'?Response.json({error:{message:'TEST 合成目录读取失败'}},{status:503}):Response.json(scenario==='empty'?[]:records.map(p=>({supplierId:p.supplierId,supplierCode:p.supplierCode,supplierType:p.supplierType,version:p.version,supplierName:p.supplierName,active:p.active,supportedCrafts:p.supportedCrafts,dailyCapacity:p.dailyCapacity,contractDataMissing:p.contractDataMissing,changedAt:p.changedAt})));
 if(url.pathname.includes('/master-data/suppliers/')){
  const supplierId=url.pathname.split('/suppliers/')[1]?.split('/')[0],profile=records.find(r=>r.supplierId===supplierId);if(!profile)return Response.json({error:{message:'TEST 合成资料不存在'}},{status:404});
  if(scenario==='detail-failure')return Response.json({error:{message:'TEST 合成详情读取失败'}},{status:503});
  return Response.json(url.pathname.endsWith('/history')?[profile,{...profile,version:1,changeReason:'TEST 原合成资料',changedAt:'2026-10-16T00:00:00Z'}]:profile);
 }
 throw Error(`Unexpected synthetic supplier read: ${path}`);
};
void verifySession().then(()=>createRoot(document.getElementById('root')!).render(<App/>));
