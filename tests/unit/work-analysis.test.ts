import Fastify from 'fastify';
import {describe,expect,it,vi} from 'vitest';
import {WorkAnalysisQuerySchema} from '@dx-rework/contracts';
import {ApplicationError} from '../../apps/api/src/platform/errors.js';
import {registerOperationDiagnostics,safeDiagnosticCode,diagnosticOutcome,readOperationDiagnostics} from '../../apps/api/src/platform/operation-diagnostics.js';
import {readQuoteAnalysis} from '../../apps/api/src/sourcing/sourcing-analysis.js';
import {readWorkflowAnalysis} from '../../apps/api/src/reporting/workflow-analysis.js';
import {canReadWorkAnalysis,historicalWorkPrice,elapsedWorkTime} from '../../apps/web/src/work-analysis-model.js';
import {registerAdminAuditRoutes} from '../../apps/api/src/admin-audit-routes.js';
import type {AdminAuditService} from '../../apps/api/src/admin-audit-service.js';
import type {AuthUser} from '../../apps/api/src/auth/service.js';
import type {Pool} from 'pg';

describe('work analysis privacy and scope',()=>{
 it('rejects invalid dates, unknown query keys and backward ranges',()=>{for(const input of [{from:'2026-02-30'},{from:'2026-09-08',to:'2026-09-07'},{page:0},{export:true}])expect(WorkAnalysisQuerySchema.safeParse(input).success).toBe(false);});
 it('validates all analysis filter variants before opening a connection',async()=>{const connect=vi.fn(),db={connect} as unknown as Pool;await expect(readQuoteAnalysis(db,{group:'factory_change'})).rejects.toMatchObject({statusCode:400});await expect(readWorkflowAnalysis(db,{group:'employee_rank'},true)).rejects.toMatchObject({statusCode:400});await expect(readOperationDiagnostics(db,{group:'raw_input'})).rejects.toMatchObject({statusCode:400});expect(connect).not.toHaveBeenCalled();});
 it('preserves historical price precision and handles missing entry time',()=>{expect(historicalWorkPrice('1234.5678')).toBe('¥1,234.5678');expect(historicalWorkPrice('1.2300')).toBe('¥1.23');expect(historicalWorkPrice(null)).toBe('历史未记录');expect(elapsedWorkTime(null,'2026-09-07T00:00:00Z')).toBe('进入时间缺失');});
 it('does not turn production or management access into audit or quotation access',()=>{const user={businessRoles:['production_management'],capabilities:['dashboard:management:read']};expect(canReadWorkAnalysis('workflow',user)).toBe(true);expect(canReadWorkAnalysis('quote',user)).toBe(false);expect(canReadWorkAnalysis('diagnostics',user)).toBe(false);expect(canReadWorkAnalysis('diagnostics',{businessRoles:['system_admin'],capabilities:[]})).toBe(false);expect(canReadWorkAnalysis('diagnostics',{businessRoles:['system_admin'],capabilities:['audit:read']})).toBe(true);});
 it('keeps safe error classes without retaining arbitrary codes',()=>{expect(safeDiagnosticCode('cookie=secret',400)).toBe('UNCLASSIFIED');expect(safeDiagnosticCode('CONFLICT',503)).toBe('INTERNAL_ERROR');expect([200,400,403,500].map(diagnosticOutcome)).toEqual(['success','validation','permission','technical']);});
 it('captures only fixed server stages, sanitized codes and confirmed replay results',async()=>{
  const app=Fastify(),rows:unknown[]=[];registerOperationDiagnostics(app,async row=>{rows.push(row);});
  app.post('/samples',async()=>{throw new ApplicationError('VALIDATION_ERROR','private receipt and bank account',400);});
  app.post('/sourcing/cases/:sourcingCaseId/ie-quotes',async(_request,reply)=>{reply.header('idempotency-replayed','true');return {secret:'never stored'};});
  app.post('/sourcing/cases/:sourcingCaseId/factory-changes',async()=>({}));app.get('/samples',async()=>({}));
  await app.inject({method:'POST',url:'/samples?token=secret',headers:{cookie:'secret','idempotency-replayed':'true','x-request-id':'private-user'},payload:{bankAccount:'secret',receipt:'secret'}});
  await app.inject({method:'POST',url:'/sourcing/cases/private-object/ie-quotes',payload:{privateInput:'secret'}});
  await app.inject({method:'POST',url:'/sourcing/cases/private-object/factory-changes'});await app.inject({method:'GET',url:'/samples'});
  expect(rows).toEqual([{operation:'sample_create',status:400,code:'VALIDATION_ERROR',replayed:false},{operation:'sourcing_ie_quote',status:200,code:'OK',replayed:true}]);expect(JSON.stringify(rows)).not.toMatch(/secret|private|bank|receipt/);await app.close();
 });
 it('does not let diagnostic storage failure change a successful business response',async()=>{const app=Fastify();registerOperationDiagnostics(app,async()=>{throw new Error('private database error');});app.post('/samples',async()=>({created:true}));const response=await app.inject({method:'POST',url:'/samples'});expect(response.statusCode).toBe(200);expect(response.json()).toEqual({created:true});await app.close();});
 it('enforces existing audit authority before diagnostic query',async()=>{for(const allowed of [false,true]){const app=Fastify(),diagnostics=vi.fn(async()=>({asOf:'test'}));registerAdminAuditRoutes(app,{authenticate:async()=>({businessRoles:['system_admin'],capabilities:allowed?['audit:read']:[]}) as unknown as AuthUser,service:{diagnostics} as unknown as AdminAuditService});const response=await app.inject({method:'GET',url:'/admin/audit/diagnostics'});expect(response.statusCode).toBe(allowed?200:403);expect(diagnostics.mock.calls).toHaveLength(allowed?1:0);if(allowed)expect(response.headers['cache-control']).toBe('no-store');await app.close();}});
});
