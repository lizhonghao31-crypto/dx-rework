import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {r5RoleFixture} from '../helpers/r5-role-fixture.js';
import {SpecialCraftLibraryService,validateSpecialCraftChoices} from '../../apps/api/src/production-platform/special-craft-library.js';
import {adoptSpecialCraft,type SpecialCraftDefinition} from '@dx-rework/contracts/digital-craft';
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
const definition=():SpecialCraftDefinition=>({name:'TEST 激光',enabled:true,development:{minutes:60.5,calendar:'continuous',reminder:{enabled:true,percent:70}},bulk:{minutes:240,calendar:'beijing_sunday_excluded',reminder:{enabled:false,percent:80}}});
(url?describe.sequential:describe.skip)('special craft library native permissions and immutable adopted versions',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,service:SpecialCraftLibraryService;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);service=new SpecialCraftLibraryService(f.db);});
 afterAll(async()=>{await f?.dispose();});
 it('preserves selected stage, old name and timing after rename, changed standards and disable',async()=>{
  const first=await service.save(f.root,{id:null,expectedVersion:0,definition:definition()},randomUUID());
  const dev=adoptSpecialCraft(first,'development'),bulk=adoptSpecialCraft(first,'bulk');
  expect(dev.standard.minutes).toBe(60.5);expect(bulk.standard.minutes).toBe(240);
  const changed={...definition(),name:'TEST 新名称',enabled:false,development:{...definition().development,minutes:180}};
  await service.save(f.root,{id:first.id,expectedVersion:1,definition:changed},randomUUID());
  expect(dev).toMatchObject({name:'TEST 激光',version:1,standard:{minutes:60.5}});
  expect(bulk.standard).toEqual(definition().bulk);
  const history=await service.history(f.root,first.id);expect(history.items.map(v=>v.version)).toEqual([2,1]);
  expect(history.items[1]).toEqual(first);expect(()=>adoptSpecialCraft(history.items[0]!,'development')).toThrow('停用');
  await expect(f.db.query("UPDATE digital_special_craft_versions SET definition='{}' WHERE craft_id=$1",[first.id])).rejects.toBeTruthy();
  await expect(f.db.query('DELETE FROM digital_special_craft_versions WHERE craft_id=$1',[first.id])).rejects.toBeTruthy();
 });
 it('permits incomplete library maintenance, but never borrows another stage duration at adoption',async()=>{
  const value=definition();value.bulk={...value.bulk,minutes:null,calendar:null};
  const saved=await service.save(f.root,{id:null,expectedVersion:0,definition:value},randomUUID());
  expect(adoptSpecialCraft(saved,'development').standard.minutes).toBe(60.5);
  expect(()=>adoptSpecialCraft(saved,'bulk')).toThrow('大货');
 });
 it('keeps idempotent receipts after later edits, rejects changed reuse and serializes stale concurrent edits',async()=>{
  const body={id:null,expectedVersion:0,definition:definition()},key=randomUUID();
  const first=await service.save(f.root,body,key);
  const results=await Promise.allSettled([service.save(f.root,{id:first.id,expectedVersion:1,definition:{...definition(),name:'TEST A'}},randomUUID()),service.save(f.root,{id:first.id,expectedVersion:1,definition:{...definition(),name:'TEST B'}},randomUUID())]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect(await service.save(f.root,body,key)).toEqual(first);
  await expect(service.save(f.root,{...body,definition:{...definition(),name:'changed'}},key)).rejects.toMatchObject({statusCode:409});
  expect((await service.history(f.root,first.id)).items).toHaveLength(2);
 });
 it('validates immutable selections, rejects stale/new disabled choices and keeps adopted orders readable when new use stops',async()=>{
  const first=await service.save(f.root,{id:null,expectedVersion:0,definition:definition()},randomUUID());
  const steps=[{craftKind:'special' as const,sequence:1,specialCraft:first}];
  await expect(validateSpecialCraftChoices(f.db,steps,[],'development',true)).resolves.toBeUndefined();
  const forged=structuredClone(steps);forged[0]!.specialCraft.definition.development.minutes=1;
  await expect(validateSpecialCraftChoices(f.db,forged,[],'development',true)).rejects.toMatchObject({statusCode:409});
  await expect(validateSpecialCraftChoices(f.db,steps,[],'development',false)).rejects.toMatchObject({statusCode:409});
  await service.save(f.root,{id:first.id,expectedVersion:1,definition:{...definition(),enabled:false}},randomUUID());
  await expect(validateSpecialCraftChoices(f.db,steps,[],'development',true)).rejects.toMatchObject({statusCode:409});
  await expect(validateSpecialCraftChoices(f.db,steps,steps,'development',false)).resolves.toBeUndefined();
  await expect(validateSpecialCraftChoices(f.db,steps,steps,'bulk',false)).resolves.toBeUndefined();
 });
 it('allows settings managers, gives PMC read only and rejects unrelated roles and revoked managers',async()=>{
  const pmc=await r5RoleFixture(f.db,f.access,f.root,'pmc');
  await expect(service.list(pmc.actor)).resolves.toHaveProperty('items');
  await expect(service.save(pmc.actor,{id:null,expectedVersion:0,definition:definition()},randomUUID())).rejects.toMatchObject({statusCode:403});
  await expect(service.list(f.people['sample-designer']!)).rejects.toMatchObject({statusCode:403});
  const manager=f.people['production-management']!;
  await expect(service.save(manager,{id:null,expectedVersion:0,definition:definition()},randomUUID())).resolves.toMatchObject({version:1});
  const assignment=(await f.db.query("SELECT assignment_id FROM user_role_assignments WHERE user_id=$1 AND role_code='production_management' AND revoked_at IS NULL",[manager.actorId])).rows[0].assignment_id;
  await f.access.revokeRole(f.root,assignment,'TEST special craft settings withdrawal');
  await expect(service.list(manager)).rejects.toMatchObject({statusCode:403});
  await expect(service.save(manager,{id:null,expectedVersion:0,definition:definition()},randomUUID())).rejects.toMatchObject({statusCode:403});
 });
});
