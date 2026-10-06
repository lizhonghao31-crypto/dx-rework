import {describe,it,expect} from 'vitest';
import {developmentWorkspaceReturnUrl} from '../../apps/web/src/development-workspace-return.js';
describe('PR06 analysis return context',()=>{
 it('retains the exact view, server filter, node and page',()=>{
  const target='/ui/digital-analysis?from=2026-10-01&to=2026-10-06&view=timing&scope=snapshot&metric=overdue&node=development_sewing&page=2';
  expect(developmentWorkspaceReturnUrl(target)).toBe(target);
 });
 it('rejects foreign, duplicated, malformed and unknown targets',()=>{
  for(const target of ['//evil.invalid/ui/digital-analysis','/\\evil.invalid/ui/digital-analysis?from=2026-10-01&to=2026-10-06&view=timing','/ui/digital-analysis?from=2026-10-01&to=2026-10-06&view=other','/ui/digital-analysis?from=2026-10-01&to=2026-10-06&view=timing&node=a&node=b','/ui/digital-analysis?from=2026-10-01&to=2026-10-06&view=timing#other','/ui/digital-analysis?from=2026-10-01&to=2026-10-06&view=timing&evil=1']) expect(developmentWorkspaceReturnUrl(target)).toBeNull();
 });
});
