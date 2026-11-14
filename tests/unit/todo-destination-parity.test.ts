import {describe,it,expect} from 'vitest';
import {todoDestination} from '../../packages/contracts/src/todo-destination.js';
import {buildTodoDeepLink} from '../../apps/api/src/todos/deep-link.js';
import {todoRouteHref} from '../../apps/web/src/todo-route-link.js';
import {validPatternReturnPath} from '../../apps/web/src/pattern-order-query.js';
const entityId='11111111-1111-4111-8111-111111111111',todoId='22222222-2222-4222-8222-222222222222';
describe('shared business destinations',()=>{
 it.each(['rework_detail','process_configuration','whole_order_review','wage_period_detail','supplier_onboarding','sample_detail','pattern_room_order','sourcing_detail','production_detail','responsibility_detail','own_factory_approval','external_responsibility_detail','digital_production_instruction','digital_development','digital_development_arrangement','digital_production_task','digital_short_lead'] as const)('keeps browser and notification destinations identical for %s',routeName=>{
  const route={routeName,entityId,todoId};expect(todoRouteHref(route)).toBe(todoDestination(route));expect(buildTodoDeepLink('/pilot/',route)).toBe('/pilot'+todoDestination(route));
 });
 it('opens normal bulk washing in its original factory page, with no alternate external route',()=>{
  const route={routeName:'digital_bulk_washing' as const,entityId,todoId};
  expect(todoRouteHref(route)).toBe(todoDestination(route));
  expect(todoDestination(route)).toContain('factoryAction=washing');
 });
 it('preserves real published version and legacy round without guessing',()=>{
  expect(todoDestination({routeName:'digital_production_instruction',entityId,todoId,developmentRound:2})).toContain('instructionVersion=2');
  expect(todoDestination({routeName:'pattern_room_order',entityId,todoId,roundId:todoId})).toContain('round='+todoId);
  expect(()=>todoDestination({routeName:'rework_detail',entityId:'bad',todoId})).toThrow();
 });
 it('returns legacy work to the board with original search and pagination',()=>{
  expect(validPatternReturnPath('/ui/digital-pattern-room?section=legacy&q=TEST&kind=misc&page=3')).toBe('/ui/digital-pattern-room?section=legacy&q=TEST&kind=misc&page=3');
  expect(validPatternReturnPath('/ui/digital-pattern-room?section=legacy&section=bulk')).toBeNull();
  expect(validPatternReturnPath('//external.example/ui/digital-pattern-room?section=legacy')).toBeNull();
 });
});
