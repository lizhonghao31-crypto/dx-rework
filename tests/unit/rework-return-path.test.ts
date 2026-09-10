import { describe, expect, it } from 'vitest';
import { reworkReturnPath } from '../../apps/web/src/rework-return-path.js';
describe('rework source return',()=>{
  it('keeps source filters and pagination, including task sources',()=>{
    expect(reworkReturnPath('','/ui/tasks?q=123&status=completed&page=3')).toBe('/ui/tasks?q=123&status=completed&page=3');
    expect(reworkReturnPath('','/ui/my-tasks?category=responsibility',true)).toBe('/ui/my-tasks?category=responsibility');
    expect(reworkReturnPath('?returnTo=%2Fui%2Ftasks%3Fpage%3D2',null)).toBe('/ui/tasks?page=2');
  });
  it('uses an internal list fallback for direct or external links',()=>{
    expect(reworkReturnPath('?returnTo=https://example.com',null)).toBe('/ui/tasks');
    expect(reworkReturnPath('','/ui/tasks/order-id')).toBe('/ui/tasks');
    expect(reworkReturnPath('',null,true)).toBe('/ui/my-tasks');
  });
});
