import {describe,it,expect} from 'vitest';
import {loadConfig} from '@dx-rework/config';
import {buildApp} from '../../apps/api/src/app.js';
import {ApplicationError} from '../../apps/api/src/platform/errors.js';
const config=loadConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://test:test@localhost/test',DINGTALK_CORP_ID:'TEST',DINGTALK_H5_APP_KEY:'TEST',DINGTALK_H5_APP_SECRET:'TEST',DINGTALK_WEB_CLIENT_ID:'TEST',DINGTALK_WEB_CLIENT_SECRET:'TEST',DINGTALK_QR_REDIRECT_URI:'https://example.test/callback',SESSION_SECRET:'TEST-only-session-secret-at-least-thirty-two-characters'});
describe('real HTTP error boundary keeps method and diagnostic identity',()=>{
 it('separates unconfirmed reads and writes, preserving status/code/request ID without raw diagnostics',async()=>{
  const app=buildApp({config,checkDatabase:async()=>{},getAppliedSchemaHistory:async()=>null});
  app.get('/TEST-feedback',async()=>{throw Error('TEST SELECT private_data');});app.post('/TEST-feedback',async()=>{throw Error('TEST SELECT private_data');});app.get('/TEST-known',async()=>{throw new ApplicationError('TEST_BUSINESS_CONFLICT','TEST资料缺少规格，请原设计师在本单补齐再交文员复核',409);});
  try{for(const method of ['GET','POST'] as const){const reply=await app.inject({method,url:'/TEST-feedback'});expect(reply.statusCode).toBe(500);expect(reply.json().error).toMatchObject({code:'INTERNAL_ERROR'});expect(reply.json().error.requestId).toBeTruthy();expect(reply.json().error.message).toContain(method==='GET'?'读取未完成':'提交结果尚未确认');expect(reply.body).not.toMatch(/SELECT|private_data/);}const head=await app.inject({method:'HEAD',url:'/TEST-feedback'});expect(head.statusCode).toBe(500);expect(head.body).toBe('');const known=await app.inject('/TEST-known');expect(known.statusCode).toBe(409);expect(known.json().error.message).toContain('原设计师');expect(known.json().error.code).toBe('TEST_BUSINESS_CONFLICT');}finally{await app.close();}
 });
});
