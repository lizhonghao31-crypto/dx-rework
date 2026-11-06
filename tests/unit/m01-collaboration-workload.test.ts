// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {describe,it,expect,vi} from 'vitest';
import type {CollaborationTask,ProductionCollaboration} from '@dx-rework/contracts/production-collaboration';
import {productionCollaborationProjection} from '../../apps/api/src/production-platform/production-collaboration-source.js';
import {productionCollaborationSheets} from '../../apps/api/src/production-platform/production-collaboration-export.js';
import {ProductionCollaborationPanel} from '../../apps/web/src/production-collaboration-panel.js';

const asOf='2026-11-06T08:00:00.000Z',person=(id:string)=>({id,name:'TEST '+id});
const task=(id:string,patch:Partial<CollaborationTask>={}):CollaborationTask=>({taskId:id,orderId:'TEST-mother',lineIds:['TEST-PO'],nodeKey:'development_pattern',label:'TEST原纸样',role:'pattern_room_worker',state:'ready',currentLoad:true,currentAssignee:person('B'),intervals:[],assigneeAtDeadline:person('A'),deadline:'2026-11-05T08:00:00.000Z',deadlineExclusive:false,deadlinePending:false,deadlineExplanation:'TEST original exact deadline; current owner is not a liability decision',handlers:[],problems:[],waitingSeconds:0,waitingCoverage:'unknown',unknown:[],sourceRefs:['TEST actual task/deadline counterpart'],...patch});
const project=(tasks:CollaborationTask[],allowed=tasks.map(t=>t.taskId))=>{
 const source:ProductionCollaboration={asOf,scopeUnknown:[],tasks,nodeSummary:[],summary:[],globalProblemCount:0,unattributedProblems:[],personalResponsibility:{available:false,reason:'TEST original liability is unavailable'},limitations:[]};
 return productionCollaborationProjection(source,allowed,[{orderId:'TEST-mother',lineId:'TEST-PO'}]);
};

describe('R2-05 original node and current-assignee workloads',()=>{
 it('keeps an old handler and deadline owner separate from the current overdue load, with identical exported task IDs',()=>{
  const data=project([task('T1',{handlers:[{eventId:'E1',kind:'blocked',person:person('A'),occurredAt:'2026-11-04T08:00:00Z',recordedAt:'2026-11-04T08:00:01Z',verified:true}]})]);
  expect(data.summary.find(row=>row.person.id==='B')).toMatchObject({currentTasks:1,currentOverdueTasks:1,currentTaskIds:['T1'],currentOverdueTaskIds:['T1'],handledTasks:0});
  expect(data.summary.find(row=>row.person.id==='A')).toMatchObject({currentTasks:0,currentOverdueTasks:0,handledTasks:1});expect(data.personalResponsibility.available).toBe(false);expect(data.summary.every(row=>row.problemTaskRate===null)).toBe(true);
  const sheets=productionCollaborationSheets(data),people=sheets.find(sheet=>sheet.name==='负荷与明确经办')!,nodes=sheets.find(sheet=>sheet.name==='当前节点负荷')!;
  expect(people.rows[0]).toContain('当前主办已知逾期任务（非过错）');expect(people.rows.find(row=>row[1]==='B')?.slice(4,9)).toEqual([1,1,0,'T1','T1']);expect(nodes.rows[1]?.slice(3,7)).toEqual([1,1,0,0]);
 });
 it('preserves inclusive instant equality, exclusive date-boundary equality, unknown deadlines and terminal exclusions',()=>{
  const data=project([task('inclusive',{deadline:asOf}),task('exclusive',{deadline:asOf,deadlineExclusive:true}),task('unknown',{deadline:null}),task('old',{currentLoad:false,state:'completed'})]);
  expect(data.summary[0]).toMatchObject({currentTasks:3,currentOverdueTasks:1,currentDeadlineUnknownTasks:1,currentTaskIds:['exclusive','inclusive','unknown'],currentOverdueTaskIds:['exclusive']});expect(data.nodeSummary[0]).toMatchObject({currentTasks:3,currentOverdueTasks:1,currentDeadlineUnknownTasks:1});
 });
 it('retains unassigned node load and calculates only the caller-authorized task set',()=>{
  const data=project([task('unassigned',{currentAssignee:null}),task('hidden',{currentAssignee:person('SECRET')})],['unassigned']);
  expect(data.tasks.map(row=>row.taskId)).toEqual(['unassigned']);expect(data.summary).toEqual([]);expect(data.nodeSummary[0]).toMatchObject({currentTasks:1,currentOverdueTasks:1,unassignedTasks:1,currentTaskIds:['unassigned']});expect(JSON.stringify(data)).not.toContain('SECRET');
 });
 it('sorts the complete same-node workload before the visible limit, drills exact tasks, and clears the drill on a different result',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  try{
   const data=project([...Array.from({length:17},(_,index)=>task('future-'+index,{currentAssignee:person('A'+index),deadline:'2026-11-10T08:00:00Z'})),...Array.from({length:3},(_,index)=>task('late-'+index,{currentAssignee:person('Z')}))]);
   const props={taskHref:(id:string)=>'/task/'+id,orderHref:(id:string)=>'/order/'+id};await act(async()=>root.render(createElement(ProductionCollaborationPanel,{...props,data})));
   const table=host.querySelector('[aria-label="人员协作，可横向滚动"]')!,first=table.querySelector('tbody tr')!;expect(first.textContent).toContain('TEST Z');expect(table.querySelectorAll('tbody tr')).toHaveLength(15);
   await act(async()=>first.querySelector<HTMLButtonElement>('td:nth-child(4) button')!.click());const drill=host.querySelector('[aria-label="当前负荷任务下钻"]')!;expect(drill.querySelectorAll('a')).toHaveLength(3);expect([...drill.querySelectorAll('a')].map(a=>a.getAttribute('href'))).toEqual(['/task/late-0','/task/late-1','/task/late-2']);
   await act(async()=>root.render(createElement(ProductionCollaborationPanel,{...props,data:project([task('new',{currentAssignee:person('NEW')})])})));expect(host.querySelector('[aria-label="当前负荷任务下钻"]')).toBeNull();expect(host.textContent).not.toContain('TEST Z');
  }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
 });
});
