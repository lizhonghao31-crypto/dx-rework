import {describe,it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {BulkPatternCardSummary,BulkPreparationSheet} from '@dx-rework/contracts/bulk-preparation';
import {PATTERN_GROUPS,type PatternWorkspaceResult,type PatternWorkspaceTask} from '@dx-rework/contracts/digital-development-workspace';
import {developmentWorkspaceReturnUrl} from '../../apps/web/src/development-workspace-return.js';
import {isConfirmedEmptyDevelopmentBoard} from '../../apps/web/src/digital-pattern-workspace.js';
import {bulkPatternLane} from '../../apps/web/src/bulk-pattern-model.js';
import {PatternBoardLane,PatternBoardCard} from '../../apps/web/src/pattern-board-parts.js';
import {BulkPatternCard} from '../../apps/web/src/bulk-pattern-card.js';
import {patternReturnPath,patternListPath,readPatternListQuery} from '../../apps/web/src/pattern-order-query.js';
const sheet=(patch:Partial<BulkPreparationSheet>={})=>({preparationId:'real-preparation',reasons:[],facts:[],tasks:[],...patch}) as BulkPreparationSheet;
const card=(patch:Partial<BulkPatternCardSummary>):BulkPatternCardSummary=>({preparationId:null,reasons:[],facts:[],task:null,lines:[],...patch});
const fact=(kind:string)=>({kind,recordedAt:'2026-10-16T00:00:00Z'});
const asOf='2026-10-16T00:00:00Z';
const task:PatternWorkspaceTask={
 journeyId:'TEST-archive',sourceId:'TEST-source',orderId:null,designStyleNo:'TEST真实开发任务',customer:null,designer:null,group:'pattern',
 node:{key:'development_pattern',instanceId:'TEST-pattern-task',label:'纸样',stage:'development',state:'active',round:2,occurrence:1,current:true,
  owner:{id:'TEST-worker',name:'TEST主办'},operator:null,assignmentHistory:[],expectedAt:null,expectedKind:'unset',expectedPrecision:'missing',
  actualAt:null,actualQuality:'missing',enteredAt:null,sla:'not_started',completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:[],
  inheritedFrom:null,countsInProgress:true,unavailableReason:null},
};
const emptyBoard:PatternWorkspaceResult={asOf,page:1,pageSize:15,total:0,archiveTotal:0,owners:[],items:[],
 counts:Object.fromEntries(PATTERN_GROUPS.map(group=>[group.key,0])) as PatternWorkspaceResult['counts'],
 riskCounts:Object.fromEntries(PATTERN_GROUPS.map(group=>[group.key,{dueSoon:0,overdue:0}])) as PatternWorkspaceResult['riskCounts']};

describe('G7 confirms only a complete current development board with zero visible tasks',()=>{
 it('accepts the explicit zero result and ignores the authorized owner directory',()=>{
  expect(isConfirmedEmptyDevelopmentBoard({...emptyBoard,owners:[{id:'TEST-worker',name:'TEST主办'}]},[],true)).toBe(true);
 });

 it.each<[string,Partial<PatternWorkspaceResult>]>([
  ['unknown task total',{total:null}],
  ['tasks on another page',{total:16,page:3}],
  ['tasks in the returned page',{items:[task]}],
  ['tasks in the preview despite the zero total',{boardPreview:[task]}],
  ['tasks in the returned risk records',{risks:[task]}],
  ['a nonzero archive count',{archiveTotal:1}],
  ['tasks in another lane',{counts:{...emptyBoard.counts!,sewing:1}}],
  ['a nonzero risk count',{riskCounts:{...emptyBoard.riskCounts!,shipping:{dueSoon:1,overdue:0}}}],
  ['partial freshness',{freshness:{pending:1,failed:0}}],
  ['a failed task detail',{detailFailures:[{journeyId:task.journeyId,designStyleNo:task.designStyleNo}]}],
 ])('withholds the board-wide empty claim for %s',(_reason,patch)=>{
  expect(isConfirmedEmptyDevelopmentBoard({...emptyBoard,...patch},[],true)).toBe(false);
 });

 it('does not hide rendered cards or reuse empty evidence across a filter or read change',()=>{
  expect(isConfirmedEmptyDevelopmentBoard(emptyBoard,[task],true)).toBe(false);
  expect(isConfirmedEmptyDevelopmentBoard(emptyBoard,[],false)).toBe(false);
  expect(isConfirmedEmptyDevelopmentBoard(null,[],true)).toBe(false);
 });
});
describe('R2 PR08 board display boundaries',()=>{
 it('shows the real special-closure response as terminal without changing its existing lane',()=>{
  const value=card({reasons:['母单已特殊结案，原实绩及历史继续保留','当前开发轮次尚未确认客户样板']});
  const before=structuredClone(value);
  const html=renderToStaticMarkup(createElement(BulkPatternCard,{item:{orderId:'closed-order',designStyleNo:'TEST-CLOSED',customer:'PD',card:value},href:'/ui/digital-production?bulk=closed-order'}));
  expect(html).toContain('已特殊结案');expect(html).toContain('原实绩及历史继续保留');expect(html).toContain('href="/ui/digital-production?bulk=closed-order"');
  for(const text of ['核对大货准备条件','待处理：','当前：','负责人：','截止：','当前开发轮次尚未确认客户样板'])expect(html).not.toContain(text);
  expect(bulkPatternLane(value)).toBe('preparing');expect(value).toEqual(before);
 });
 it('keeps an active missing prerequisite actionable without inferring closure from a similar phrase',()=>{
  const value=card({reasons:['TEST 尚未特殊结案，需核对原资料']});
  const html=renderToStaticMarkup(createElement(BulkPatternCard,{item:{orderId:'active-order',designStyleNo:'TEST-ACTIVE',customer:'PD',card:value},href:'/ui/digital-production?bulk=active-order'}));
  expect(html).toContain('核对大货准备条件');expect(html).toContain('待处理：');expect(html).not.toContain('>已特殊结案<');
 });
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
