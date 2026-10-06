import {describe,it,expect} from 'vitest';
import {cockpitReturnPath} from '../../apps/web/src/digital-journey-cockpit-model.js';
import {workspaceGroupStatus} from '../../apps/web/src/digital-production-workspace-model.js';
import type {JourneyNode} from '@dx-rework/contracts/digital-production-journey';
const node=(state:JourneyNode['state'])=>({state} as JourneyNode);
describe('V2 production workspace factual boundaries',()=>{
 it('retains selected order, filters and intended workspace on original handling return',()=>{
  const target='/ui/digital-cockpit?page=2&search=TEST&stage=post_cutting&selected=11111111-1111-4111-8111-111111111111&workspace=factory';
  const result=cockpitReturnPath('?returnTo='+encodeURIComponent(target));expect(result).toContain('workspace=factory');expect(result).toContain('page=2');expect(result).toContain('selected=11111111-1111-4111-8111-111111111111');
 });
 it('rejects duplicate, fragment, external, unknown workspace and unknown query return targets',()=>{
  for(const target of ['/ui/digital-cockpit?page=1&page=2','/ui/digital-cockpit?page=1#evil','https://evil.invalid/ui/digital-cockpit?page=1','/ui/digital-cockpit?workspace=other','/ui/digital-cockpit?workspace=factory&evil=1','/ui/digital-cockpit?workspace=factory&selected=invalid']) expect(cockpitReturnPath('?returnTo='+encodeURIComponent(target))).toBeNull();
 });
 it('never turns partial or permission-hidden gates into completion',()=>{
  expect(workspaceGroupStatus([node('completed'),node('pending')])).toBe('待前置');
  expect(workspaceGroupStatus([node('completed'),node('unavailable')])).toBe('部分事实不可见');
  expect(workspaceGroupStatus([])).toBe('尚无原事实');
  expect(workspaceGroupStatus([node('completed'),node('not_applicable')])).toBe('已完成');
 });
});
