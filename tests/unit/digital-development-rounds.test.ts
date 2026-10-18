import {describe,expect,it} from 'vitest';
import {developmentRevisionPlan} from '../../apps/api/src/production-platform/development-round-plan.js';
import {developmentRoute} from '../../apps/api/src/production-platform/development-route.js';
import type {DevelopmentRevision} from '@dx-rework/contracts/digital-development-rounds';
const input=(outputKind:DevelopmentRevision['outputKind'],affectedNodes:DevelopmentRevision['affectedNodes'])=>({document:{craft:'印花',washing:'内洗'},outputKind,affectedNodes} as DevelopmentRevision);
const allCompleted=()=>Object.fromEntries(['development_materials',...developmentRoute({craft:'印花',washing:'内洗'})].map(node=>[node,{taskId:`prior-${node}`,roundNumber:1}]));
describe('revision work versus inherited facts',()=>{
 it('keeps a seam repair local and references completed paper, craft and washing',()=>{
  const plan=developmentRevisionPlan(input('整件样板',['车板']),allCompleted());
  expect(plan.route).toEqual(['development_sewing_transfer','development_sewing','development_tail_check','development_confirmation','development_shipping']);
  expect(plan.inherited.development_pattern).toEqual({taskId:'prior-development_pattern',roundNumber:1});
  expect(plan.inherited.development_washing).toBeDefined();
 });
 it('does not invent an inherited washing completion when prior work never happened',()=>{
  const completed=allCompleted();delete completed.development_washing;delete completed.development_washing_dispatch;
  const plan=developmentRevisionPlan(input('整件样板',['车板']),completed);
  expect(plan.route.indexOf('development_washing')).toBeLessThan(plan.route.indexOf('development_tail_check'));
  expect(plan.inherited.development_washing).toBeUndefined();
 });
 it('does not generate garment sewing or tail inspection for a craft swatch',()=>{
  const plan=developmentRevisionPlan(input('工艺布片',['工艺']),{});
  expect(plan.route).toContain('development_materials');expect(plan.route).toContain('development_printing');
  expect(plan.route).not.toContain('development_sewing');expect(plan.route).not.toContain('development_tail_check');expect(plan.route).not.toContain('development_washing');
  expect(plan.inherited).toEqual({});
 });
 it('keeps a missing transfer in the saved garment craft route while inheriting already completed sewing',()=>{
  const completed=allCompleted();delete completed.development_sewing_transfer;
  const plan=developmentRevisionPlan(input('整件样板',['工艺']),completed);
  expect(plan.route).toEqual(['development_craft_dispatch','development_printing','development_craft_confirmation','development_sewing_transfer','development_tail_check','development_confirmation','development_shipping']);
  expect(plan.inherited.development_sewing).toEqual({taskId:'prior-development_sewing',roundNumber:1});
  expect(plan.inherited.development_washing).toBeDefined();
 });
});
