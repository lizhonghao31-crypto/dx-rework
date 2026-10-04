import {describe,it,expect} from 'vitest';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import {bulkCockpitProgress} from '../../apps/api/src/production-platform/cockpit-progress.js';
const task=(taskKind:string,state='completed')=>({taskKind,state} as DigitalTask);
describe('P15 applicable whole-order progress',()=>{
 it('excludes unneeded preshrink and craft/QC and does not count PO rows',()=>{
  const input={preshrink:'无需预缩',secondaryCraft:'无',externalCutting:false,tasks:[task('bulk_pattern'),task('bulk_cutting'),task('bulk_cutting')],received:false,packed:false,specialClosed:false};
  expect(bulkCockpitProgress(input)).toEqual({applicable:7,completed:2});
 });
 it('includes required craft and preshrink and never counts cancelled tasks or special closure as completed packing',()=>{
  expect(bulkCockpitProgress({preshrink:'需要预缩',secondaryCraft:'印花',externalCutting:true,tasks:[task('bulk_cutting_external'),task('process_logistics','cancelled')],received:true,packed:true,specialClosed:true})).toEqual({applicable:10,completed:2});
 });
});
