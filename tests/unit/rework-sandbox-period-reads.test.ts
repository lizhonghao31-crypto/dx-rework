// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {WorkflowAnalysisQuerySchema} from '@dx-rework/contracts';
import {ReworkDataSandboxPage} from '../../apps/web/src/rework-data-sandbox-page.js';

vi.mock('../../apps/web/src/components.js',()=>({Header:()=>null,Shell:({children}:{children:unknown})=>children}));
vi.mock('../../apps/web/src/rework-module-tabs.js',()=>({ReworkModuleTabs:()=>null}));
vi.mock('../../apps/web/src/auth.js',()=>({verifySession:async()=>({status:'authorized',user:{id:'TEST-reader',capabilities:['dashboard:management:read'],businessRoles:['production_management']}})}));

afterEach(()=>{vi.unstubAllGlobals();});

describe('original rework sandbox period reads',()=>{
  it('reads both periods once, then changes only A on node selection and paging',async()=>{
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
    window.history.replaceState({},'', '?aFrom=2026-09-01&aTo=2026-09-30&bFrom=2026-08-01&bTo=2026-08-31');
    const requests:URLSearchParams[]=[];
    let failPrimary=false;
    const request=vi.fn(async(url:string)=>{
      const parsed=new URL(url,window.location.href);
      expect(parsed.pathname).toBe('/api/management/workflow-analysis');
      requests.push(parsed.searchParams);
      const filters=WorkflowAnalysisQuerySchema.parse(Object.fromEntries(parsed.searchParams));
      if(failPrimary&&filters.from==='2026-09-01'){
        failPrimary=false;
        return {ok:false};
      }
      return {ok:true,json:async()=>({asOf:'2026-11-18T08:00:00.000Z',filters,total:18,groups:[],missingEntryCount:0,items:[],
        nodeMetrics:[{status:'in_progress',flowCount:1,averageFlowSeconds:3600,openCount:1,longestOpenSeconds:3600}],
      })};
    });
    vi.stubGlobal('fetch',request);
    const shell=document.createElement('div');document.body.append(shell);const root=createRoot(shell);
    const button=(name:string)=>[...shell.querySelectorAll('button')].find(item=>item.textContent?.trim()===name||item.getAttribute('aria-label')===name)!;
    try{
      await act(async()=>root.render(createElement(ReworkDataSandboxPage)));
      expect(requests.map(item=>item.get('from'))).toEqual(['2026-09-01','2026-08-01']);
      await act(async()=>button('查看事项').click());
      expect(requests.at(-1)?.get('node')).toBe('in_progress');
      await act(async()=>button('2').click());
      expect(requests.map(item=>[item.get('from'),item.get('page')])).toEqual([
        ['2026-09-01','1'],['2026-08-01','1'],['2026-09-01','1'],['2026-09-01','2'],
      ]);
      expect(shell.textContent).toContain('对比期');
      failPrimary=true;
      await act(async()=>button('清除节点筛选').click());
      expect(shell.querySelector('[role="alert"]')?.textContent).toContain('分析期间 A');
      expect(shell.textContent).toContain('对比期：进入 0 · 完成 0');
      await act(async()=>button('重试分析期间 A').click());
      expect(shell.querySelector('[role="alert"]')).toBeNull();
      expect(requests.filter(query=>query.get('from')==='2026-08-01')).toHaveLength(1);
    }finally{await act(async()=>root.unmount());shell.remove();}
  });
});
