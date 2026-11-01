import {calculateProductionProgress} from '../../packages/domain/src/production-progress.js';
import {todoDestination} from '@dx-rework/contracts/todo-destination';
import {describe,it,expect} from 'vitest';
import {qcProgressClock,SubmitQcProgressSchema} from '@dx-rework/contracts/qc-production-progress';
import {randomUUID} from 'node:crypto';
const base={trackingId:'tracking',startedAt:'2026-12-01T15:59:00.000Z',latestProgressId:null,latestCollectedAt:null,finished:false};
describe('QC rolling observation contract',()=>{
 it.each([
  ['2026-12-03T15:58:59.999Z','not_due'],['2026-12-03T15:59:00.000Z','due'],['2026-12-04T15:59:00.000Z','escalated'],
  ['2026-12-03T23:59:00+08:00','due'],
 ])('uses exact48/72h, including offset and midnight at %s',(at,state)=>expect(qcProgressClock(base,at).state).toBe(state));
 it('does not turn missing/future anchors into new supervision',()=>{
  expect(qcProgressClock({...base,trackingId:null},'2026-12-03T15:59:00Z').state).toBe('unknown');
  expect(qcProgressClock(base,'2026-11-30T00:00:00Z').state).toBe('unknown');
  expect(qcProgressClock(base,'invalid').state).toBe('unknown');
 });
 it('a current observation starts its window, older backfill does not reset the start',()=>{
  expect(qcProgressClock({...base,latestProgressId:'new',latestCollectedAt:'2026-12-02T16:00:00Z'},'2026-12-03T15:59:00Z')).toMatchObject({state:'not_due',basis:'progress',windowKey:'progress:new'});
  expect(qcProgressClock({...base,latestProgressId:'old',latestCollectedAt:'2026-11-30T16:00:00Z'},'2026-12-03T15:59:00Z')).toMatchObject({state:'due',basis:'start',windowKey:'start:tracking'});
 });
 it('keeps finished production separate from overdue observation',()=>expect(qcProgressClock({...base,finished:true},'2027-01-01T00:00:00Z').state).toBe('finished'));
 it('requires event photos, rejects duplicate scopes and does not accept fake zero quantities',()=>{
  const line={lineId:randomUUID(),state:'working',cuttingPercent:50,sewingPercent:30,ironingPercent:null,reason:''};
  const input={submissionId:randomUUID(),factoryDecisionId:null,expectedScopeRevision:'a'.repeat(64),expectedProgressRevision:0,kind:'progress',collectedAt:'2026-12-01T00:00:00Z',observations:[line],criticalEvents:[],attachmentIds:[],note:''};
  expect(SubmitQcProgressSchema.safeParse(input).success).toBe(true);
  expect(SubmitQcProgressSchema.safeParse({...input,criticalEvents:['first_piece']}).success).toBe(false);
  expect(SubmitQcProgressSchema.safeParse({...input,observations:[line,line]}).success).toBe(false);
  expect(SubmitQcProgressSchema.safeParse({...input,observations:[{...line,additionalFinishedQuantity:0}]}).success).toBe(false);
  expect(SubmitQcProgressSchema.safeParse({...input,observations:[{...line,state:'not_started',cuttingPercent:0,sewingPercent:0,ironingPercent:0,reason:'真实未开工，等待排产'}]}).success).toBe(true);
 });
 it('photo-only cannot smuggle new progress/time/quantity',()=>{
  const input={submissionId:randomUUID(),factoryDecisionId:null,expectedScopeRevision:'a'.repeat(64),expectedProgressRevision:1,kind:'photos',relatedProgressRecordId:randomUUID(),collectedAt:null,observations:[],criticalEvents:[],attachmentIds:[randomUUID()],note:'补传原现场照片'};
  expect(SubmitQcProgressSchema.safeParse(input).success).toBe(true);
  expect(SubmitQcProgressSchema.safeParse({...input,collectedAt:'2026-12-02T00:00:00Z'}).success).toBe(false);
 });
});

describe('QC timer replaces only the obsolete calendar-day stale cue',()=>{
 const facts={status:'in_production' as const,quantity:100,completedQuantity:10,firstReportedOn:'2026-11-01',deliveryDate:'2026-11-20',lastUpdatedAt:'2026-11-01T00:00:00Z',completedOn:null};
 it('keeps quantity and delivery risk, while a fresh observation clears only missing-update risk',()=>{
  const result=calculateProductionProgress({...facts,qcObservation:{state:'not_due',anchor:'2026-11-05T00:00:00Z',remindAt:'2026-11-07T00:00:00Z',escalateAt:'2026-11-08T00:00:00Z'}},'2026-11-05T01:00:00Z');expect(result.progressState).not.toBe('stale');expect(result.completedQuantity).toBe(10);expect(result.quantityRiskState).toBe('behind');
  expect(calculateProductionProgress(facts,'2026-11-05T01:00:00Z').progressState).toBe('stale');
 });
 it('opens the original unified factory workspace under the same exact factory scope',()=>{
  const id='00000000-0000-4000-8000-000000000001',factory='00000000-0000-4000-8000-000000000002',url=new URL(todoDestination({routeName:'digital_factory_progress',entityId:id,todoId:id,factoryDecisionId:factory}),'https://example.test');expect(url.searchParams.get('factoryAction')).toBe('productionProgress');expect(url.searchParams.get('factoryDecisionId')).toBe(factory);
 });
});
