import {slaAnchorTime} from '@dx-rework/domain/digital-sla-plan';
import type {OrderTimeCheckResult} from '@dx-rework/contracts/order-time-requests';
import type {OrderTimeInput} from './order-time-plan-repository.js';
import type {evaluateTimeFrameworkCandidate} from './order-time-framework.js';
import type {FactoryDeliveryReading} from '@dx-rework/contracts/order-closure';

/** Once every current positive allocation has genuinely delivered, its first
 * delivery is history, not remaining work to reschedule. Leave punctuality,
 * unknown occurrence times and uncollected quantities to the original ledger.
 * An absent/ambiguous allocation cannot borrow a sibling factory's receipt. */
export function outstandingFactoryCommitments(commitments:NonNullable<OrderTimeInput['factoryCommitments']>,deliveries:readonly FactoryDeliveryReading[]){
 return commitments.filter(commitment=>{
  const own=deliveries.filter(row=>row.lineId===commitment.lineId&&row.expected>0);
  return !own.length||own.some(row=>row.delivered!==true);
 });
}

/** Compare the declared return plan with the original factory commitment.
 * This is a planning constraint, never proof of first receipt or collection.
 * Actual first delivery remains the native per-factory receipt ledger reading.
 * No commitment yet is valid: creating an order cannot invent a supplier date.
 */
export function orderTimeFactoryCommitments(commitments:NonNullable<OrderTimeInput['factoryCommitments']>,candidates:readonly ReturnType<typeof evaluateTimeFrameworkCandidate>[]):NonNullable<OrderTimeCheckResult['factoryCommitments']>{
 return commitments.map(commitment=>{
  const candidate=candidates.find(row=>row.input.scopeRef===`po:${commitment.lineId}`);
  const work=candidate?.input.work.filter(row=>row.parameterKey==='return_logistics'&&row.id.endsWith(':'+commitment.lineId))??[];
  const end=work.length===1?candidate?.arranged.find(row=>row.id===work[0]!.id)?.end:null;
  const target=slaAnchorTime({precision:'date',value:commitment.date,source:commitment.source},'工厂交货日期');
  const delta=end?.at&&target.at?(Date.parse(end.at)-Date.parse(target.at)+(end.at===target.at&&!end.exclusive?1:0))/60000:null;
  return {...commitment,plannedReceipt:end?.at??null,lateMinutes:delta===null?null:Math.max(0,delta),status:delta===null?'unknown':delta>0?'insufficient':'sufficient'};
 });
}
