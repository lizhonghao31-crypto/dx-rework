// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {CockpitRetryUpdates} from '../../apps/web/src/cockpit-retry-updates.js';
import {digitalRequest} from '../../apps/web/src/digital-production-api.js';
vi.mock('../../apps/web/src/digital-production-api.js',()=>({digitalRequest:vi.fn()}));
let root:Root,host:HTMLDivElement;
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});vi.clearAllMocks();host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
it('queues later independent mothers after one failure, deduplicates and bounds the retry set, while reporting actual failure',async()=>{
 const request=vi.mocked(digitalRequest),updated=vi.fn(),ids=['TEST-0','TEST-0',...Array.from({length:20},(_,i)=>'TEST-'+i)];
 request.mockImplementation(async(path)=>{if(path.includes('TEST-0/'))throw Error('TEST first mother unavailable');return {};});
 await act(async()=>root.render(createElement(CockpitRetryUpdates,{ids,onUpdated:updated})));
 await act(async()=>host.querySelector('button')!.click());
 expect(request.mock.calls.map(call=>call[0])).toEqual(Array.from({length:15},(_,i)=>`journeys/TEST-${i}/refresh`));
 expect(request.mock.calls.every(call=>call[1]==='POST')).toBe(true);expect(updated).toHaveBeenCalledTimes(1);
 expect(host.querySelector('[role=alert]')?.textContent).toContain('1 单重试未成功');expect(host.querySelector('button')!.disabled).toBe(false);
});
it('finishes already requested idempotent writes after navigation without applying an old result to the new page',async()=>{
 let release!:(value:unknown)=>void;const updated=vi.fn(),request=vi.mocked(digitalRequest);
 request.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;})).mockResolvedValue({});
 await act(async()=>root.render(createElement(CockpitRetryUpdates,{ids:['TEST-old-a','TEST-old-b'],onUpdated:updated})));
 await act(async()=>host.querySelector('button')!.click());expect(request).toHaveBeenCalledTimes(1);
 await act(async()=>root.render(null));await act(async()=>release({}));
 expect(request).toHaveBeenCalledTimes(2);expect(updated).not.toHaveBeenCalled();
});
