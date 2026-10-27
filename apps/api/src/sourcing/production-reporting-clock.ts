import type {Pool,PoolClient} from 'pg';
import {validateBusinessTime} from '@dx-rework/domain/business-clock';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {acceptanceBusinessContext,ContextBusinessClock} from '../acceptance-clock/business-time.js';
import {ApplicationError} from '../platform/errors.js';

type Query=Pick<PoolClient,'query'>;
/** Original immutable production/case links are validated by the same SQL scope as writes. */
export async function productionReportingObservation(pool:Pool,db:Query,id:string){
 const scope=(await db.query<{native_order_id:string|null;scenario_id:string|null;wall_now:Date}>(
  'SELECT scope.*,CURRENT_TIMESTAMP AS wall_now FROM sourcing_production_clock_scope($1) scope',[id])).rows[0]!;
 const conflict=()=>{throw new ApplicationError('ACCEPTANCE_ISOLATION','生产填报缺少匹配的原单业务时钟',409);};
 if(!scope.native_order_id){if(acceptanceBusinessContext())conflict();return {asOf:scope.wall_now.toISOString(),businessToday:beijingCalendarDate(scope.wall_now)};}
 const time=validateBusinessTime(await new ContextBusinessClock(pool,db===pool?undefined:db as PoolClient).read({kind:'order',id:scope.native_order_id}));
 if(time.scenarioId!==scope.scenario_id)conflict();
 const asOf=scope.scenario_id?time.now:scope.wall_now.toISOString();
 return {asOf,businessToday:beijingCalendarDate(new Date(asOf))};
}
/** Called after this transaction's original operation event, also enforced independently by SQL triggers. */
export async function assertProductionReportingDate(db:Query,id:string,eventId:string,date:string){
 const row=(await db.query<{today:string}>('SELECT sourcing_production_business_date($1,$2)::text AS today',[id,eventId])).rows[0]!;
 if(date>row.today)throw new ApplicationError('VALIDATION_ERROR','业务日期不能晚于本单业务今天',400);
}
