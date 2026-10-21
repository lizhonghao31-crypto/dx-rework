import {randomUUID} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {loadConfig} from '@dx-rework/config';
import {buildApp} from '../../apps/api/src/app.js';
import type {ReworkInitiationService} from '../../apps/api/src/rework/service.js';
const id=randomUUID();
const config=loadConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://test:test@localhost/test',DINGTALK_CORP_ID:'corp',DINGTALK_H5_APP_KEY:'key',DINGTALK_H5_APP_SECRET:'secret',DINGTALK_WEB_CLIENT_ID:'web',DINGTALK_WEB_CLIENT_SECRET:'secret',DINGTALK_QR_REDIRECT_URI:'https://example.test/callback',SESSION_SECRET:'a-test-session-secret-with-at-least-32-characters'});
const retired=[['POST','/integrations/erp/v1/rework-orders'],['GET','/integrations/erp/v1/rework-orders/intake-receipt'],['GET',`/integrations/erp/v1/rework-orders/${id}/link-receipt`],['POST',`/integrations/erp/v1/rework-orders/${id}/link`],['GET',`/integrations/erp/v1/rework-orders/${id}/result`],['POST','/admin/erp-emergency/v1/rework-orders'],['GET','/admin/erp-emergency/v1/rework-orders/intake-receipt'],['GET',`/admin/erp/v1/rework-orders/${id}/result`]] as const;
describe('legacy external ERP retirement',()=>{
 it('does not register any retired ingress, emergency, receipt or result route even for an authenticated administrator',async()=>{
  const authenticate=vi.fn(async()=>({id:randomUUID(),displayName:'TEST Root',businessRoles:['root_superuser','system_admin'],capabilities:['erp:integrate','erp:emergency_intake','erp:result:read']}));
  const getOwn=vi.fn();const app=buildApp({config,checkDatabase:async()=>undefined,rework:{authenticate,service:{getOwn}as unknown as ReworkInitiationService}});
  try{for(const [method,url]of retired){const response=await app.inject({method,url,headers:{cookie:'dx_rework_session=TEST','idempotency-key':'TEST-retired'},...(method==='POST'?{payload:{contractVersion:'1'}}:{})});expect(response.statusCode,url).toBe(404);}expect(authenticate).not.toHaveBeenCalled();expect(getOwn).not.toHaveBeenCalled();}finally{await app.close();}
 });
 it('preserves native human draft and read routes with their original authorization boundary',async()=>{
  const actorId=randomUUID(),receivingBatchId=randomUUID(),createDraft=vi.fn(async()=>({value:{reworkOrderId:id,status:'draft'},reused:false})),getOwn=vi.fn(async()=>({reworkOrderId:id,status:'draft'}));
  const app=buildApp({config,checkDatabase:async()=>undefined,rework:{authenticate:async()=>({id:actorId,displayName:'TEST品控',businessRoles:['quality_control'],capabilities:['rework:initiate','rework:view']}),service:{createDraft,getOwn}as unknown as ReworkInitiationService}});
  try{const created=await app.inject({method:'POST',url:'/rework-orders/drafts',headers:{'idempotency-key':'TEST-native'},payload:{styleNo:'TEST本系统人工创建',receivingBatchId}});expect(created.statusCode,created.body).toBe(201);expect(createDraft).toHaveBeenCalledWith(expect.objectContaining({actorId,authorizationCapability:'rework:initiate'}),expect.objectContaining({receivingBatchId}),'TEST-native');expect((await app.inject({url:`/rework-orders/${id}`})).statusCode).toBe(200);createDraft.mockClear();expect((await app.inject({method:'POST',url:'/rework-orders/drafts',headers:{'idempotency-key':'TEST-forged-source'},payload:{styleNo:'TEST不得恢复旧来源入口',receivingBatchId,sourceSystem:'erp',externalId:'TEST-old'}})).statusCode).toBe(400);expect(createDraft).not.toHaveBeenCalled();}finally{await app.close();}
  const denied=buildApp({config,checkDatabase:async()=>undefined,rework:{authenticate:async()=>({id:actorId,displayName:'TEST工人',businessRoles:['worker'],capabilities:[]}),service:{createDraft,getOwn}as unknown as ReworkInitiationService}});
  try{createDraft.mockClear();expect((await denied.inject({method:'POST',url:'/rework-orders/drafts',headers:{'idempotency-key':'TEST-denied'},payload:{styleNo:'TEST拒绝',receivingBatchId}})).statusCode).toBe(403);expect(createDraft).not.toHaveBeenCalled();}finally{await denied.close();}
 });
});
