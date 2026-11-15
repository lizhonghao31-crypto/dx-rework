import {describe,it,expect} from 'vitest';
import {CustomerCommentOccurrenceSchema,RecordFinalCommentSchema,SupplementCommentTimeSchema} from '@dx-rework/contracts/digital-development-technical';
import {customerCommentTime,commentTimeDto} from '../../apps/api/src/production-platform/development-comment-time.js';
import {orderTimeCompletionBound} from '../../apps/api/src/production-platform/order-time-request-plan.js';
const now=new Date('2026-11-15T03:00:00Z');
describe('customer actual feedback time, separate from registration and review',()=>{
 it('keeps legacy missing time unknown and only uses now after explicit current selection',()=>{
  expect(customerCommentTime(undefined,null,now)).toEqual({occurredAt:null,occurredDate:null});
  expect(customerCommentTime({precision:'unknown'},null,now)).toEqual({occurredAt:null,occurredDate:null});
  expect(customerCommentTime({precision:'current'},null,now)).toEqual({occurredAt:now.toISOString(),occurredDate:null});
 });
 it('preserves date precision and original legacy instants without inventing midnight',()=>{
  expect(customerCommentTime({precision:'date',date:'2026-11-14'},null,now)).toEqual({occurredAt:null,occurredDate:'2026-11-14'});
  expect(customerCommentTime(undefined,'2026-11-14T10:00:00Z',now).occurredAt).toBe('2026-11-14T10:00:00Z');
  expect(commentTimeDto({occurred_date:'2026-11-14'})).toMatchObject({occurredAt:null,occurredDate:'2026-11-14'});
 });
 it('rejects future evidence and ambiguous duplicated timestamp sources',()=>{
  expect(()=>customerCommentTime({precision:'date',date:'2026-11-16'},null,now)).toThrow('不能在未来');
  expect(()=>customerCommentTime({precision:'instant',at:'2026-11-15T03:00:00.001Z'},null,now)).toThrow('不能在未来');
  const base={roundNumber:1,scopeRef:'整款',expectedVersion:0,isFinal:true,decision:'approved',text:'TEST',evidenceRefs:[],evidenceNote:'TEST original evidence',occurredAt:'2026-11-14T00:00:00Z'};
  expect(RecordFinalCommentSchema.safeParse({...base,actualTime:{precision:'date',date:'2026-11-14'}}).success).toBe(false);
  expect(RecordFinalCommentSchema.safeParse(base).success).toBe(true);
  expect(CustomerCommentOccurrenceSchema.safeParse({precision:'date',date:'not-date'}).success).toBe(false);
  expect(SupplementCommentTimeSchema.safeParse({commentId:'00000000-0000-4000-8000-000000000001',commentVersion:1,actualTime:{precision:'unknown'},note:'TEST real record'}).success).toBe(false);
 });
 it('uses a completed date as a conservative planning boundary, capped at observation, while preserving the actual date fact',()=>{
  const fact={actualAt:null,actualDate:'2026-11-14'};
  expect(orderTimeCompletionBound(fact,now.toISOString())).toEqual({at:'2026-11-14T16:00:00.000Z',exclusive:true,reasons:[]});
  expect(orderTimeCompletionBound(fact,'2026-11-14T12:00:00.000Z')).toEqual({at:'2026-11-14T12:00:00.000Z',exclusive:false,reasons:[]});
  expect(fact).toEqual({actualAt:null,actualDate:'2026-11-14'});
  expect(orderTimeCompletionBound({actualAt:null},now.toISOString()).at).toBeNull();
 });
});
