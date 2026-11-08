import {afterEach,describe,it,expect,vi} from 'vitest';
import {createElement} from 'react';
import type * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SlaOrderApplicationPanel} from '../../apps/web/src/sla-order-application-panel.js';
const state=vi.hoisted(()=>({seeds:[] as unknown[]}));
vi.mock('react',async load=>{const actual=await load<typeof React>();return {...actual,useState:(initial:unknown)=>actual.useState(state.seeds.length?state.seeds.shift():initial)};});
afterEach(()=>{state.seeds=[];});
const render=(notificationChanges:unknown[])=>{
 const id='TEST-only-order',preview={orderId:id,token:'TEST read-only rendering, not an auth/token fixture',configurationVersion:4,changes:[],skipped:[],notificationChanges};
 state.seeds=[[],'',1,[id],'TEST selected change',{[id]:{state:'previewed',preview}},false,'',0,{[id]:{designStyleNo:'TEST trusted style'}}];
 return renderToStaticMarkup(createElement(SlaOrderApplicationPanel,{version:4,parameterKeys:['warning_ratio','ship_sample_advance'],disabled:false,onPendingChange:()=>undefined,expanded:true}));
};
describe('selected-order reminder preview decision',()=>{
 it('shows disabled and enabled transitions even when numeric thresholds and dates have no changes',()=>{
  const html=render([{key:'warning_ratio',label:'节点临期提醒',beforeEnabled:true,afterEnabled:false},{key:'ship_sample_advance',label:'船样提前提醒',beforeEnabled:false,afterEnabled:true}]);
  expect(html).toContain('节点临期提醒');expect(html).toContain('开启 → 关闭');expect(html).toContain('船样提前提醒');expect(html).toContain('关闭 → 开启');expect(html).toContain('启停不取消任务或改写历史');expect(html).toContain('确认逐单应用');
 });
 it('does not invent an enable-change notice when the selected preview contains no changed flags',()=>{expect(render([])).not.toContain('提醒启停变化');});
});
