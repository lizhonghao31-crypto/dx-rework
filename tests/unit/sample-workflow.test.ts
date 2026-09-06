import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {SampleBorrowRequestSchema,SampleReturnRequestSchema,SampleReturnBatchSchema,SampleConfirmSchema,SampleCancelSchema} from '../../packages/contracts/src/sample-workflow.js';
import {buildTodoDeepLink} from '../../apps/api/src/todos/deep-link.js';
import {todoModuleIdsForUser} from '../../apps/web/src/platform-access.js';
describe('sample handoff contracts and module integration',()=>{
 it('requires version, purpose, current pictures and stable IDs',()=>{
  expect(SampleBorrowRequestSchema.safeParse({version:1,purpose:'开发',borrowerUserId:randomUUID()}).success).toBe(true);
  for(const input of [{purpose:'开发'},{version:1,purpose:''},{version:1,purpose:'开发',borrowerUserId:'同名员工'},{version:1,purpose:'开发',status:'borrowed'}])expect(SampleBorrowRequestSchema.safeParse(input).success).toBe(false);
  expect(SampleReturnRequestSchema.safeParse({version:1,photoAttachmentIds:[]}).success).toBe(false);
  expect(SampleReturnBatchSchema.safeParse({items:[{sampleId:randomUUID(),version:1,photoAttachmentIds:[randomUUID()]}]}).success).toBe(true);
  expect(SampleConfirmSchema.safeParse({version:1,token:'姓名二维码'}).success).toBe(false);
  expect(SampleCancelSchema.safeParse({version:1,reason:''}).success).toBe(false);
 });
 it('routes sample tasks within the configured platform prefix and rejects technical role inheritance',()=>{
  const entityId=randomUUID(),todoId=randomUUID();expect(buildTodoDeepLink('/platform/',{routeName:'sample_detail',entityId,todoId})).toBe(`/platform/ui/samples/${entityId}?todo=${todoId}`);
  const capabilities=['todo:view','sample:view_basic'];
  for(const role of ['sample_designer','sample_administrative','sample_finance','owner_group'])expect(todoModuleIdsForUser({businessRoles:[role],capabilities})).toContain('samples');
  expect(todoModuleIdsForUser({businessRoles:['system_admin'],capabilities})).not.toContain('samples');
  expect(todoModuleIdsForUser({businessRoles:[],capabilities:[],isRoot:true})).toContain('samples');
 });
});
