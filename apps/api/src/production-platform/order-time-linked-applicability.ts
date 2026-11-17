import type {Pool,PoolClient} from 'pg';
import type {BusinessTime,BusinessTimeScope} from '@dx-rework/domain/business-clock';
import type {OrderTimeRule} from '@dx-rework/contracts/order-time-plan';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {loadOrderTimeOperation} from './order-time-operation-state.js';
import type {LinkedOrderTimeQualification} from './order-time-plan-repository.js';

export function applicableLinkedOrderTimeChanges(scope:{complete:boolean;parameterKeys:readonly string[]},changes:Readonly<Record<string,OrderTimeRule>>){
 if(!scope.complete)throw new ApplicationError('ORDER_TIME_CONFLICT','关联对象当前适用范围尚未明确，请核对原单后再安排',409);
 const keys=new Set(scope.parameterKeys);
 return Object.fromEntries(Object.entries(changes).filter(([key])=>keys.has(key)));
}

/** Read the target without foreign changes first. Only proven inapplicable
 * keys are omitted; permission, versions, begun work and read failures still
 * fail the original whole transaction. Both stored plan formats use this path. */
export async function refreshLinkedOrderTimeInput(database:Pool,db:PoolClient,actor:TrustedActorContext,resource:BusinessTimeScope,time:BusinessTime,changes:Record<string,OrderTimeRule>):Promise<LinkedOrderTimeQualification>{
 const baseline=await loadOrderTimeOperation(database,db,actor,{kind:'arrangement',resource},time);
 const updates=applicableLinkedOrderTimeChanges(baseline.linkedApplicability,changes);
 if(!Object.keys(updates).length)return {value:baseline.value,updates};
 const current=await loadOrderTimeOperation(database,db,actor,{kind:'arrangement',resource},time,updates);
 return {value:current.value,updates};
}
