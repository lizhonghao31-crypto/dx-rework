import {describe,it,expect} from 'vitest';
import {loadConfig} from '@dx-rework/config';
import {buildApp} from '../../apps/api/src/app.js';
import {ApplicationError} from '../../apps/api/src/platform/errors.js';
const config=loadConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://test:test@localhost/test',DINGTALK_CORP_ID:'TEST',DINGTALK_H5_APP_KEY:'TEST',DINGTALK_H5_APP_SECRET:'TEST',DINGTALK_WEB_CLIENT_ID:'TEST',DINGTALK_WEB_CLIENT_SECRET:'TEST',DINGTALK_QR_REDIRECT_URI:'https://example.test/callback',SESSION_SECRET:'TEST-only-session-secret-at-least-thirty-two-characters'});
describe('real HTTP error boundary keeps method and diagnostic identity',()=>{
 it('classifies the existing read-only POST routes by their registered contract, without letting a header or suffix relabel a command',async()=>{
  const app=buildApp({config,checkDatabase:async()=>{},getAppliedSchemaHistory:async()=>null});
  const routes=['whole-orders/delete-preview','sla-settings/calculation-preview','sla-settings/sets/calculate','order-time-settings/calculate','customers/default-merchandisers/selected','order-time/check','order-time/preview','order-time/requests/:requestId/preview'];
  for(const path of routes)app.post('/digital-production/'+path,async request=>{if((request.query as {known?:string}).known)throw new ApplicationError('TEST_READ_FAILURE','SELECT TEST private query',502);throw Error('SELECT TEST private query');});
  app.post('/digital-production/order-time/not-real/check',async()=>{throw Error('SELECT TEST private write');});
  app.post('/digital-production/sources/:id/confirm',async()=>{throw Error('SELECT TEST private write');});
  try{
   for(const path of routes){const response=await app.inject({method:'POST',url:'/digital-production/'+path.replace(':requestId','12345678-1111-4111-8111-123456789012'),payload:{TEST:'original'}});
    expect(response.statusCode).toBe(500);expect(response.json().error).toMatchObject({code:'INTERNAL_ERROR'});expect(response.json().error.requestId).toBeTruthy();expect(response.json().error.message).toContain('读取未完成');expect(response.body).not.toMatch(/提交结果|SELECT|private query/);}
   for(const path of ['order-time/not-real/check','sources/12345678-1111-4111-8111-123456789012/confirm']){
    const response=await app.inject({method:'POST',url:'/digital-production/'+path,headers:{'x-read-only':'true'},payload:{readOnly:true}});
    expect(response.statusCode).toBe(500);expect(response.json().error.message).toContain('提交结果尚未确认');
   }
   const known=await app.inject({method:'POST',url:'/digital-production/order-time/check?known=1'});expect(known.statusCode).toBe(502);expect(known.json().error).toMatchObject({code:'TEST_READ_FAILURE'});expect(known.json().error.message).toContain('读取未完成');expect(known.body).not.toMatch(/private query|提交结果/);
  }finally{await app.close();}
 });
 it('separates unconfirmed reads and writes, preserving status/code/request ID without raw diagnostics',async()=>{
  const app=buildApp({config,checkDatabase:async()=>{},getAppliedSchemaHistory:async()=>null});
  app.get('/TEST-feedback',async()=>{throw Error('TEST SELECT private_data');});app.post('/TEST-feedback',async()=>{throw Error('TEST SELECT private_data');});app.get('/TEST-known',async()=>{throw new ApplicationError('TEST_BUSINESS_CONFLICT','TEST资料缺少规格，请原设计师在本单补齐再交文员复核',409);});
  for(const status of [409,408,502])app.post(`/TEST-unmapped-${status}`,async()=>{throw new ApplicationError('TEST_UNMAPPED','Outbox idempotency key was used with different semantics',status);});
  try{for(const status of [409,408,502]){const reply=await app.inject({method:'POST',url:`/TEST-unmapped-${status}`});expect(reply.statusCode).toBe(status);expect(reply.json().error.message).toContain(status===409?'已被拒绝':'尚未确认');expect(reply.body).not.toContain('Outbox');}for(const method of ['GET','POST'] as const){const reply=await app.inject({method,url:'/TEST-feedback'});expect(reply.statusCode).toBe(500);expect(reply.json().error).toMatchObject({code:'INTERNAL_ERROR'});expect(reply.json().error.requestId).toBeTruthy();expect(reply.json().error.message).toContain(method==='GET'?'读取未完成':'提交结果尚未确认');expect(reply.body).not.toMatch(/SELECT|private_data/);}const head=await app.inject({method:'HEAD',url:'/TEST-feedback'});expect(head.statusCode).toBe(500);expect(head.body).toBe('');const known=await app.inject('/TEST-known');expect(known.statusCode).toBe(409);expect(known.json().error.message).toContain('原设计师');expect(known.json().error.code).toBe('TEST_BUSINESS_CONFLICT');}finally{await app.close();}
 });
});
