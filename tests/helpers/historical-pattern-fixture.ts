import type {PatternOrderDetail} from '@dx-rework/contracts/pattern-orders';
import type {PatternRoomOrderService} from '../../apps/api/src/pattern-room/order-service.js';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
/** Seed the historical native shape through its private transaction assembler.
 * Public create is deliberately closed. This test-only helper keeps the original
 * pricing/attachment/idempotency fixture facts for historical processing/wage tests;
 * it is not an application capability or a production environment switch.
 */
export function createHistoricalPatternFixture(service:PatternRoomOrderService,actor:TrustedActorContext,input:unknown,key:string){
 return (service as unknown as {createOrder(actor:TrustedActorContext,kind:'pattern',input:unknown,key:string):Promise<PatternOrderDetail>}).createOrder(actor,'pattern',input,key);
}
