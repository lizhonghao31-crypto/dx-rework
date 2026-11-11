import {digitalSlaDefaults} from '@dx-rework/contracts/digital-sla';
import {DEVELOPMENT_CYCLE_DEFAULTS} from '@dx-rework/contracts/digital-development-technical';
import {ORDER_TIME_NODES,OrderTimeConfigurationSchema,orderTimeConfigurationFromLegacy} from '@dx-rework/contracts/order-time-settings';

/** Independent, hand-countable TEST arrangement: each applicable work takes an
 * hour. Included handoffs remain inside their parent and branches join by max.
 */
export function r5OneHourConfiguration(){
 const values=orderTimeConfigurationFromLegacy({unified:digitalSlaDefaults(),development:DEVELOPMENT_CYCLE_DEFAULTS,planning:{}});
 for(const node of ORDER_TIME_NODES){const rule=values.nodes[node.key]!;if(rule.kind==='work'||rule.kind==='forecast'||rule.kind==='supervision')values.nodes[node.key]={...rule,minutes:60};}
 return OrderTimeConfigurationSchema.parse(values);
}
