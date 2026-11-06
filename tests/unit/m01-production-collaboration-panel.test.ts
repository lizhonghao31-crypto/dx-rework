// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {ProductionCollaboration} from '@dx-rework/contracts/production-collaboration';
import {ProductionCollaborationPanel} from '../../apps/web/src/production-collaboration-panel.js';

let host:HTMLDivElement,root:Root;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
it('reveals every original-order problem link when only unattributed problems exceed the initial page',async()=>{
 const data:ProductionCollaboration={asOf:'2026-11-06T08:00:00Z',scopeUnknown:[],tasks:[],nodeSummary:[],summary:[],globalProblemCount:16,unattributedProblems:Array.from({length:16},(_,index)=>({id:'TEST problem '+index,orderId:'TEST-order-'+index,lineIds:[],kind:'TEST quality gap '+index,sourceRefs:['TEST original issue']})),personalResponsibility:{available:false,reason:'TEST no personal responsibility evidence'},limitations:[]};
 await act(async()=>root.render(createElement(ProductionCollaborationPanel,{data,taskHref:id=>'/task/'+id,orderHref:id=>'/order/'+id})));
 expect(host.querySelectorAll('a')).toHaveLength(15);expect(host.querySelector('a[href="/order/TEST-order-15"]')).toBeNull();
 const more=[...host.querySelectorAll('button')].find(button=>button.textContent==='继续显示后15项');expect(more).toBeDefined();await act(async()=>more!.click());
 expect(host.querySelectorAll('a')).toHaveLength(16);expect(host.querySelector('a[href="/order/TEST-order-15"]')?.textContent).toBe('查看原母单问题');expect(host.querySelector('button')).toBeNull();
});
