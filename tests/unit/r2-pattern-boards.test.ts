import {describe,it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {BulkPreparationSheet} from '@dx-rework/contracts/bulk-preparation';
import {developmentWorkspaceReturnUrl} from '../../apps/web/src/development-workspace-return.js';
import {bulkPatternLane} from '../../apps/web/src/bulk-pattern-model.js';
import {PatternBoardLane,PatternBoardCard} from '../../apps/web/src/pattern-board-parts.js';
import {patternReturnPath,patternListPath,readPatternListQuery} from '../../apps/web/src/pattern-order-query.js';
const sheet=(patch:Partial<BulkPreparationSheet>={})=>({preparationId:'real-preparation',reasons:[],facts:[],tasks:[],...patch}) as BulkPreparationSheet;
const fact=(kind:string)=>({kind,recordedAt:'2026-10-16T00:00:00Z'});
describe('R2 PR08 board display boundaries',()=>{
 it('requires both independent valid outputs for the completed lane',()=>{
  expect(bulkPatternLane(sheet({facts:[fact('纸样派交'),fact('纸样完成')]}))).toBe('handling');
  expect(bulkPatternLane(sheet({facts:[fact('纸样派交'),fact('唛架完成')]}))).toBe('handling');
  const value=sheet({facts:[fact('纸样完成'),fact('唛架完成')]});const before=structuredClone(value);expect(bulkPatternLane(value)).toBe('completed');expect(value).toEqual(before);
 });
 it('does not infer delivery or work started from assignment or missing prerequisite records',()=>{
  expect(bulkPatternLane(sheet({preparationId:null}))).toBe('preparing');
  expect(bulkPatternLane(sheet({reasons:['当前开发轮次尚未确认客户样板']}))).toBe('preparing');
  expect(bulkPatternLane(sheet({dispatch:{version:1,patternWorkerId:'assigned',warehouseWorkerId:null,cuttingWorkerId:null}}))).toBe('dispatch');
  expect(bulkPatternLane(sheet({facts:[fact('纸样派交')]}))).toBe('handling');
 });
 it('shares lane/card DOM while keeping business-specific titles and a header-level full-list action',()=>{
  const html=renderToStaticMarkup(createElement(PatternBoardLane,{lane:'craft',title:'待准备',count:4,onAll(){}},createElement(PatternBoardCard,{onClick(){}},'真实任务')));
  expect(html).toMatch(/<h3[^>]*>[\s\S]*查看全部[\s\S]*<\/h3>/);expect(html).toContain('pattern-task-card');expect(html).toContain('真实任务');expect(html).not.toContain('<table');
 });
 it('restores independently scoped bulk and development task return paths',()=>{
  for(const path of ['/ui/digital-pattern-room?section=bulk&scope=all&page=2&search=TEST','/ui/digital-pattern-room?section=development&scope=all&state=all&page=3'])expect(developmentWorkspaceReturnUrl(path,'/')).toBe(path);
  expect(developmentWorkspaceReturnUrl('/ui/digital-pattern-room?section=foreign','/')).toBeNull();
 });
 it('keeps standalone historical source, exact filters and page on the native detail return',()=>{
  const query={q:'同名款',kind:'pattern',origin:'standalone' as const,status:'in_progress',creatorId:'',workerId:'',page:2};
  expect(readPatternListQuery(patternListPath(query).split('?')[1]!)).toEqual(query);
  const target='/ui/digital-pattern-room?section=development&source=standalone&'+patternListPath(query).split('?')[1];
  expect(patternReturnPath('?'+new URLSearchParams({returnTo:target}))).toBe(target);
  expect(patternReturnPath('?'+new URLSearchParams({returnTo:target+'&page=3'}))).toBe('/ui/pattern-room/orders');
 });
});
