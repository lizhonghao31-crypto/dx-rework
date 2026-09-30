// All writes modify in-memory synthetic records only.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {SupplierCenterPage} from '../../apps/web/src/supplier-center-page.js';
import {CreateSupplierSchema,ReviseSupplierSchema} from '@dx-rework/contracts';
import '../../packages/ui/src/tokens.css';
import '../../packages/ui/src/components.css';
import '../../apps/web/src/styles.css';
import '../../apps/web/src/workflow-shell.css';
import '../../apps/web/src/dialog-visual-system.css';
import '../../apps/web/src/workflow-state-visual.css';
import '../../apps/web/src/ui-polish.css';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sample={supplierId:id(1),supplierCode:'FAC_FIXTURE_01',supplierType:'factory',version:1,supplierName:'合成测试 · 广州市达兴服装长期合作加工厂第一生产基地',active:true,notes:'合成资料，非真实供应商',contactPerson:'测试联系人',contactPhone:'020-00000000',address:'合成测试地址第一生产区',contractEntityName:'合成合同主体',partyBRepresentative:'测试代表',payeeName:'测试收款人',bankAccount:'001234567890',bankName:'合成开户行',supportedCrafts:['车缝','整烫'],dailyCapacity:12800,contractDataMissing:[],changeReason:'合成初始资料',changedBy:id(100),changedAt:'2026-09-08T01:00:00Z'};
type Profile=typeof sample;
const records:Profile[]=[sample];const histories=new Map<string,Profile[]>([[sample.supplierId,[sample]]]);let reads=0,created=10;
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','x-dx-rework-actor-id':id(100)}});
window.fetch=async(input,init)=>{
 const u=new URL(String(input),location.origin),method=init?.method??'GET';
 if(u.pathname.endsWith('/indicator'))return reply({pendingCount:0});
 if(!u.pathname.includes('/master-data/suppliers'))return reply({},404);
 if(method==='GET'&&u.pathname.endsWith('/suppliers')){reads++;if(document.body.dataset.mode==='pending'&&reads===1)return reply({error:{message:'合成目录暂时不可用，请刷新重试'}},503);return reply(records);}
 if(method==='POST'&&document.body.dataset.scenario==='large')return reply({error:{message:'无权维护供应商'}},403);
 if(method==='POST'&&u.pathname.endsWith('/suppliers')){const parsed=CreateSupplierSchema.safeParse(JSON.parse(String(init?.body)));if(!parsed.success)return reply({error:{message:'资料不完整'}},400);const data=parsed.data;if(records.some(x=>x.supplierCode===data.supplierCode))return reply({error:{message:'供应商编码已存在'}},409);const profile={...sample,...data,supplierId:id(created++),version:1,contractDataMissing:[],changedAt:new Date().toISOString()} as Profile;records.push(profile);histories.set(profile.supplierId,[profile]);return reply({supplierId:profile.supplierId,version:1},201);}
 const target=u.pathname.split('/suppliers/')[1]?.split('/')[0],current=records.find(x=>x.supplierId===target);if(!current)return reply({error:{message:'供应商不存在'}},404);
 if(method==='POST'){const parsed=ReviseSupplierSchema.safeParse(JSON.parse(String(init?.body)));if(!parsed.success)return reply({error:{message:'资料校验失败'}},400);if(document.body.dataset.mode==='disposed'||parsed.data.expectedVersion!==current.version)return reply({error:{message:'供应商资料已更新，请刷新后重试'}},409);const next={...current,...parsed.data,version:current.version+1,changedAt:new Date().toISOString()} as Profile;records.splice(records.indexOf(current),1,next);histories.set(target!,[next,...histories.get(target!)!]);return reply({supplierId:target,version:next.version},201);}
 return reply(u.pathname.endsWith('/history')?histories.get(target!):current);
};
createRoot(document.getElementById('root')!).render(<SupplierCenterPage mode={document.body.dataset.mode==='detail'?'directory':'manage'}/>);
