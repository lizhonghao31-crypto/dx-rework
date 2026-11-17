import {afterEach,expect,it,vi} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {DigitalTask,DigitalTaskCompletion} from '@dx-rework/contracts/digital-production-tasks';
import type {FactoryFlowSheet} from '@dx-rework/contracts/factory-flow';
import {TaskCompletionTime,taskCompletionText} from '../../apps/web/src/task-completion-time.js';
import {FactoryBatchPanel} from '../../apps/web/src/factory-batch-panel.js';
import {digitalDetailReturnUrl} from '../../apps/web/src/digital-detail-route.js';
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
const at='2026-11-09T09:57:06.850Z';
it('renders verified instant, date-only, unverified instant, unknown and trusted A without P without reversing their meaning',()=>{
 const cases:Array<[DigitalTaskCompletion,string]>=[
  [{precision:'instant',at,date:null,quality:'verified',sourceRef:null},'2026/11/9'],
  [{precision:'date',at:null,date:'2026-11-09',quality:'unverified',sourceRef:null},'2026-11-09（仅日期 · 时间待核）'],
  [{precision:'instant',at,date:null,quality:'unverified',sourceRef:null},'时间待核'],
  [{precision:'unknown',at:null,date:null,quality:'missing',sourceRef:null},'时间未知'],
  [{precision:'instant',at,date:null,quality:'verified',sourceRef:null},'2026/11/9'],
 ];
 for(const [completion,text] of cases){
  const task={actualCompletion:completion,completedAt:completion.at,timeQuality:'补报未核实',dueAt:null} as DigitalTask,html=renderToStaticMarkup(createElement(TaskCompletionTime,{task}));
  expect(html).toContain('实际完成');expect(html).toContain(text);expect(html).not.toContain('未登记');
  if(completion.quality==='verified')expect(html).not.toContain('待核');
  if(completion.precision==='date')expect(html).not.toContain('00:00');
 }
});
it('degrades old optional completion DTOs using completion quality, never responsibility quality',()=>{
 expect(taskCompletionText({completedAt:at})).toContain('时间待核');
 expect(taskCompletionText({completedAt:at,completedTimeQuality:'已核实'})).not.toContain('待核');
 expect(taskCompletionText({completedAt:null})).toBe('时间未知');
});
const id='00000000-0000-4000-8000-000000000001',line='00000000-0000-4000-8000-000000000002';
it.each(['/','/acceptance/'])('keeps the real factory quotation anchor and validated return in %s with original management access',base=>{
 vi.stubEnv('BASE_URL',base);vi.stubGlobal('window',{location:{pathname:base+'ui/digital-production',search:`?factory=${id}&line=${line}&factoryAction=logistics`}});
 const sheet={orderId:id,secondaryCraft:'特殊工艺',craftSteps:[{stepId:id,sequence:1,specialCraft:{definition:{name:'TEST'}}}],canManage:true,lines:[]} as unknown as FactoryFlowSheet;
 const props={sheet,busy:false,paused:false,action:'overview',save:async()=>undefined,upload:async()=>undefined,images:{},previews:{}};
 const html=renderToStaticMarkup(createElement(FactoryBatchPanel,props)),href=html.match(/href="([^"]+)"[^>]*>报价与指派/)?.[1]?.replaceAll('&amp;','&');expect(href).toBeTruthy();
 const url=new URL(href!,'https://TEST.invalid');expect(url.pathname).toBe(base+'ui/digital-quotation');expect(url.searchParams.get('id')).toBe(id);
 const back=digitalDetailReturnUrl(url.searchParams.get('returnTo'),base);expect(back).toBeTruthy();expect(new URL(back!,'https://TEST.invalid').searchParams.get('line')).toBe(line);
 expect(renderToStaticMarkup(createElement(FactoryBatchPanel,{...props,sheet:{...sheet,canManage:false}}))).not.toContain('报价与指派');
});
