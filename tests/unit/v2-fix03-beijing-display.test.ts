import {describe,it,expect} from 'vitest';
import {shanghaiBusinessTime} from '../../apps/web/src/business-date.js';
describe('FIX03 original event timestamps in Beijing',()=>{
 it('shows the same original instant in Beijing under different host timezones',()=>{
  const previous=process.env.TZ;
  try{for(const zone of ['Asia/Shanghai','America/Los_Angeles','UTC']){process.env.TZ=zone;expect(shanghaiBusinessTime('2026-10-06T06:39:35.000Z')).toBe('2026/10/6 14:39:35（北京时间）');}}
  finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
 });
 it('keeps seconds and the Beijing date across midnight without changing the stored instant',()=>{
  const original='2026-10-05T16:00:01.000Z';expect(shanghaiBusinessTime(original)).toBe('2026/10/6 00:00:01（北京时间）');expect(new Date(original).toISOString()).toBe(original);
 });
});
