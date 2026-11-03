import type {Pool} from 'pg';
import {describe,it,expect,vi} from 'vitest';
import {readBulkPreshrinkRequirement,retiredBulkPreshrinkTaskIds} from '../../apps/api/src/production-platform/bulk-preshrink-requirement.js';
import {PreshrinkCorrectionApplySchema,PreshrinkCorrectionPreviewSchema} from '../../apps/api/src/production-platform/bulk-preshrink-correction-service.js';

const prep={preparation_id:'11111111-1111-4111-8111-111111111111',preshrink:'需要预缩'};
const database=(exists:boolean,rows:unknown[])=>{
 const query=vi.fn().mockResolvedValueOnce({rows:[{relation:exists?'digital_bulk_preshrink_corrections':null}]}).mockResolvedValue({rows});
 return {db:{query} as unknown as Pick<Pool,'query'>,query};
};
describe('scoped preshrink correction read provenance',()=>{
 it('retains the frozen requirement when the successor correction table is absent',async()=>{
  const {db,query}=database(false,[]);
  expect(await readBulkPreshrinkRequirement(db,prep,{preshrink:'无需预缩'})).toEqual({requirement:'需要预缩',correctionId:null,retiredTaskId:null});
  expect(query).toHaveBeenCalledTimes(1);
 });
 it('does not treat a standalone no-preshrink fact or a later instruction as a correction',async()=>{
  const {db,query}=database(true,[]);
  expect((await readBulkPreshrinkRequirement(db,prep,{preshrink:'无需预缩'})).requirement).toBe('需要预缩');
  expect(query).toHaveBeenLastCalledWith(expect.stringContaining('WHERE preparation_id=$1'),[prep.preparation_id]);
  expect(query.mock.calls.some(([sql])=>String(sql).includes('digital_bulk_preparation_facts'))).toBe(false);
 });
 it('returns the exact append-only correction and retired task without mutating the original prep',async()=>{
  const original=structuredClone(prep),{db}=database(true,[{correction_id:'correction-id',preshrink_task_id:'task-id'}]);
  expect(await readBulkPreshrinkRequirement(db,prep)).toEqual({requirement:'无需预缩',correctionId:'correction-id',retiredTaskId:'task-id'});
  expect(prep).toEqual(original);
 });
 it.each(['无需预缩',undefined,null,'invalid'])('does not overlay a correction on an unrelated or unknown original %s',async preshrink=>{
  const {db,query}=database(true,[{correction_id:'wrong',preshrink_task_id:'wrong'}]);
  expect((await readBulkPreshrinkRequirement(db,{...prep,preshrink})).requirement).toBe(preshrink==='无需预缩'?'无需预缩':null);
  expect(query).not.toHaveBeenCalled();
 });
 it('takes denominator exclusions from correction targets rather than all cancelled tasks',async()=>{
  const {db,query}=database(true,[{preshrink_task_id:'specific-task'}]);
  expect(await retiredBulkPreshrinkTaskIds(db)).toEqual(['specific-task']);
  expect(query).toHaveBeenLastCalledWith('SELECT preshrink_task_id FROM digital_bulk_preshrink_corrections ORDER BY preshrink_task_id');
 });
 it('preserves old-schema denominator behavior without a correction table',async()=>{
  expect(await retiredBulkPreshrinkTaskIds(database(false,[]).db)).toEqual([]);
 });
 it('rejects a bulk or unversioned correction request before any command runs',()=>{
  expect(PreshrinkCorrectionPreviewSchema.safeParse({preparationIds:[prep.preparation_id]}).success).toBe(false);
  expect(PreshrinkCorrectionApplySchema.safeParse({target:{preparationId:prep.preparation_id,instructionVersion:4},reason:'x',expectedFingerprint:'a'.repeat(64)}).success).toBe(false);
 });
});
