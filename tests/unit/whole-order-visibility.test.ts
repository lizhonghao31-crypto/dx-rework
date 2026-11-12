import type {Pool} from 'pg';
import {describe,it,expect,vi} from 'vitest';
import {DigitalProductionAccessPolicy} from '../../apps/api/src/production-platform/access-policy.js';
import {rememberWholeOrderSnapshot,forgetWholeOrderSnapshot} from '../../apps/api/src/production-platform/whole-order-visibility.js';
const root={actorId:'TEST-root',actorRoles:['root_superuser'],authorizationCapability:'digital_production:view',requestId:'TEST-deletion-snapshot'};

describe('whole-order deletion facts stay inside their caller-owned read snapshot',()=>{
 it('reuses only selected IDs on that connection and restores atomic filtering at snapshot end',async()=>{
  const query=vi.fn(async(sql:string)=>sql.startsWith('SELECT to_regclass')?{rows:[{relation:'digital_whole_order_deleted_objects'}],rowCount:1}:{rows:sql.includes('NOT EXISTS')?[]:[{production_order_id:'selected'}],rowCount:sql.includes('NOT EXISTS')?0:1});
  const snapshot={query} as unknown as Pool,other={query} as unknown as Pool;rememberWholeOrderSnapshot(snapshot,['selected']);
  expect(await new DigitalProductionAccessPolicy(snapshot).allowed(root,'order','selected','technical')).toBe(true);
  expect(query.mock.calls.at(-1)![0]).toBe('SELECT * FROM digital_production_orders WHERE production_order_id=$1');
  expect(await new DigitalProductionAccessPolicy(snapshot).allowed(root,'order','unselected','technical')).toBe(false);
  expect(await new DigitalProductionAccessPolicy(other).allowed(root,'order','selected','technical')).toBe(false);
  forgetWholeOrderSnapshot(snapshot);expect(await new DigitalProductionAccessPolicy(snapshot).allowed(root,'order','selected','technical')).toBe(false);
  expect(query.mock.calls.at(-1)![0]).toContain('NOT EXISTS');
 });
 it('does not retain an ordinary Root permission result after an order is deleted',async()=>{
  let deleted=false;const query=vi.fn(async(sql:string)=>sql.startsWith('SELECT to_regclass')?{rows:[{relation:'digital_whole_order_deleted_objects'}],rowCount:1}:{rows:deleted?[]:[{production_order_id:'order'}],rowCount:deleted?0:1}),db={query} as unknown as Pool,policy=new DigitalProductionAccessPolicy(db);
  expect(await policy.allowed(root,'order','order','technical')).toBe(true);deleted=true;
  expect(await policy.allowed(root,'order','order','technical')).toBe(false);
  expect(query.mock.calls.filter(([sql])=>!sql.startsWith('SELECT to_regclass')).every(([sql])=>sql.includes('NOT EXISTS'))).toBe(true);
 });
});
