import type {Pool,PoolClient} from 'pg';
import {validateBusinessTime} from '@dx-rework/domain/business-clock';
import {acceptanceBusinessContext,acceptanceClockReaderEnabled,businessScopeKey,ContextBusinessClock} from '../acceptance-clock/business-time.js';
import {ApplicationError} from '../platform/errors.js';

const conflict=():never=>{throw new ApplicationError('ACCEPTANCE_ISOLATION','合同回签缺少匹配的原单业务时钟',409);};
/** Existing transactions must use their own connection, including background callers without ALS. */
export async function contractReturnClock(pool:Pool,db:Pick<PoolClient,'query'>,caseId:string){
 const scope=(await db.query<{native_order_id:string|null;scenario_id:string|null}>(
  'SELECT * FROM sourcing_contract_return_clock_scope($1)',[caseId])).rows[0]!;
 if(!scope.native_order_id){if(acceptanceBusinessContext())conflict();return null;}
 const time=validateBusinessTime(await new ContextBusinessClock(pool,db===pool?undefined:db as PoolClient).read({kind:'order',id:scope.native_order_id}));
 if(time.scenarioId!==scope.scenario_id)conflict();
 return time;
}

/** The list consumes only validation, while the single-case writer keeps its own clock. */
export async function assertContractReturnCaseClocks(pool:Pool,caseIds:readonly string[]){
 if(!caseIds.length)return;
 const scoped=(await pool.query<{native_order_id:string|null;scenario_id:string|null}>(
  `SELECT scope.native_order_id,scope.scenario_id FROM unnest($1::uuid[]) cases(case_id)
   CROSS JOIN LATERAL sourcing_contract_return_clock_scope(cases.case_id) scope`,[caseIds])).rows;
 if(scoped.length!==caseIds.length)conflict();
 const orders=new Set<string>();
 const inAcceptance=Boolean(acceptanceBusinessContext());
 for(const scope of scoped){
  if(scope.native_order_id)orders.add(scope.native_order_id);
  else if(inAcceptance)conflict();
 }
 const clock=await new ContextBusinessClock(pool).readMany([...orders].map(id=>({kind:'order' as const,id})));
 for(const scope of scoped){
  if(!scope.native_order_id)continue;
  const time=clock.get(businessScopeKey({kind:'order',id:scope.native_order_id}));
  if(!time||validateBusinessTime(time).scenarioId!==scope.scenario_id)conflict();
 }
}

/** Validate before SQL filtering: a missing reader cannot hide bound rows by returning an empty page. */
export async function assertContractReturnListClock(pool:Pool){
 const context=acceptanceBusinessContext();
 const scopes=(await pool.query<{scenario_id:string|null;case_id:string}>(`SELECT DISTINCT ON (r.scenario_id)
  r.scenario_id,c.sourcing_case_id AS case_id FROM sourcing_cases c
  LEFT JOIN digital_production_child_links l ON l.module='sourcing' AND l.child_id=c.sourcing_case_id
  LEFT JOIN acceptance_sla_clock_resources r ON r.resource_kind='order' AND r.resource_id=l.production_order_id
  WHERE c.deleted_at IS NULL ORDER BY r.scenario_id,c.sourcing_case_id`)).rows;
 if(scopes.some(scope=>scope.scenario_id)&&!context&&!acceptanceClockReaderEnabled(pool))conflict();
 if(context&&scopes.some(scope=>scope.scenario_id!==context.scenarioId))conflict();
 await assertContractReturnCaseClocks(pool,scopes.filter(scope=>scope.scenario_id).map(scope=>scope.case_id));
}
