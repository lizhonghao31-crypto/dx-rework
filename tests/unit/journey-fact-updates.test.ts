import {afterEach,describe,expect,it,vi} from 'vitest';
import {JourneyFactRuntime} from '../../apps/api/src/production-platform/journey-fact-updates.js';
describe('journey fact runtime lifecycle',()=>{
 afterEach(()=>vi.useRealTimers());
 it('never overlaps batches, drains its active work and does not restart after stop',async()=>{
  vi.useFakeTimers();let release!:()=>void;
  const registerBackfill=vi.fn(async()=>({registered:0,cursor:null,done:true}));
  const runOnce=vi.fn(()=>new Promise<{built:number;retired:number;failed:number;busy:number}>(resolve=>{release=()=>resolve({built:0,retired:0,failed:0,busy:0});}));
  const runtime=new JourneyFactRuntime({registerBackfill,runOnce},{warn:vi.fn()},1000);
  runtime.start();runtime.start();await vi.advanceTimersByTimeAsync(3000);expect(runOnce).toHaveBeenCalledTimes(1);expect(registerBackfill).toHaveBeenCalledTimes(1);
  const stop=runtime.stop();release();await stop;await vi.advanceTimersByTimeAsync(3000);expect(runOnce).toHaveBeenCalledTimes(1);
 });
 it('resumes bounded startup pages and keeps failures visible without rejecting the next tick',async()=>{
  vi.useFakeTimers();const warn=vi.fn(),registerBackfill=vi.fn().mockResolvedValueOnce({registered:200,cursor:'order:cursor',done:false}).mockResolvedValue({registered:0,cursor:null,done:true});
  const runOnce=vi.fn().mockRejectedValueOnce(Error('TEST')).mockResolvedValue({built:1,retired:0,failed:1,busy:0});
  const runtime=new JourneyFactRuntime({registerBackfill,runOnce},{warn},1000);runtime.start();await vi.advanceTimersByTimeAsync(2100);await runtime.stop();
  expect(registerBackfill.mock.calls.map(args=>args[0])).toEqual([null,'order:cursor']);expect(warn).toHaveBeenCalledTimes(3);expect(runOnce).toHaveBeenCalledTimes(3);
 });
});
