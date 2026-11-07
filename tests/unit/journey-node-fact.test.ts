import { expect, it } from 'vitest';
import type { JourneyNode } from '@dx-rework/contracts/digital-production-journey';
import { journeyNodeFactTarget, mergeJourneyNodeFact } from '../../apps/api/src/production-platform/journey-node-fact.js';

const node = (): JourneyNode => ({ key: 'sourcing_preparation', instanceId: 'TEST-current-task', label: '外发准备',
  stage: 'preparation', state: 'completed', round: 2, occurrence: 1, current: true,
  owner: { id: 'TEST-owner', name: '原负责人' }, ownerStatus: 'assigned', operator: { id: 'TEST-operator', name: '原办理人' },
  assignmentHistory: [], expectedAt: '2026-11-07T08:00:00.000Z', expectedPrecision: 'instant', expectedKind: 'sla',
  actualAt: '2026-11-07T07:00:00.000Z', actualQuality: 'verified', enteredAt: '2026-11-06T08:00:00.000Z',
  sla: 'finished', completionResult: 'early', overdueSeconds: 0, risks: [], blockers: [],
  records: [{ domain: 'task', id: 'TEST-current-task', url: '/ui/digital-production?task=TEST-current-task', version: 2, lineId: null, mode: 'read' }],
  inheritedFrom: null, countsInProgress: true, unavailableReason: null });
const scope = (value: JourneyNode) => ({ key: value.key, instanceId: value.instanceId, round: value.round, current: value.current });

it('Final10 a later kind-level completion without time or owner does not erase the same task proof', () => {
  const before = node(), original = structuredClone(before);
  const result = mergeJourneyNodeFact(before, { ...scope(before), state: 'completed', actualAt: undefined, owner: undefined });
  expect(result).toMatchObject({ instanceId: before.instanceId, round: 2, enteredAt: before.enteredAt,
    expectedAt: before.expectedAt, actualAt: before.actualAt, actualQuality: 'verified', owner: before.owner, operator: before.operator });
  expect(before).toEqual(original);
});

it('Final10 a later task observation with an omitted completion keeps a native proof for the exact same instance', () => {
  const native = node(); native.owner = null;
  const result = mergeJourneyNodeFact(native, { ...scope(native), owner: { id: 'TEST-owner', name: '已核负责人' }, enteredAt: native.enteredAt, actualAt: undefined });
  expect(result).toMatchObject({ actualAt: native.actualAt, actualQuality: 'verified', owner: { name: '已核负责人' } });
});

it.each(['different-instance', 'different-round', 'retired-instance'])('Final10 never copies completion across %s', change => {
  const previous = node(), fact = scope(previous);
  if (change === 'different-instance') fact.instanceId = 'TEST-other-task';
  if (change === 'different-round') fact.round = 3;
  if (change === 'retired-instance') fact.current = false;
  expect(mergeJourneyNodeFact(previous, { ...fact, state: 'completed' })).toBeNull();
});

it('Final10 an explicit corrected unknown time clears the old instant and date instead of reviving either', () => {
  const previous = { ...node(), actualDate: '2026-11-07' };
  const result = mergeJourneyNodeFact(previous, { ...scope(previous), actualAt: null });
  expect(result).toMatchObject({ state: 'completed', actualAt: null, actualDate: null, actualQuality: 'missing' });
});

it('Final10 a withdrawn completion retains its original start and target but removes completion-only metadata', () => {
  const previous = node();
  const result = mergeJourneyNodeFact(previous, { ...scope(previous), state: 'pending' });
  expect(result).toMatchObject({ enteredAt: previous.enteredAt, expectedAt: previous.expectedAt,
    actualAt: null, actualDate: null, actualQuality: 'missing', operator: null, completionResult: null, overdueSeconds: null });
  expect(mergeJourneyNodeFact(result!, { ...scope(previous), state: 'completed' })).toMatchObject({ actualAt: null, actualQuality: 'missing' });
});

it('Final10 an explicit corrected instant replaces an older date-only observation', () => {
  const before = { ...node(), actualDate: '2026-11-06' };
  expect(mergeJourneyNodeFact(before, { ...scope(before), actualAt: '2026-11-07T06:00:00Z' }))
    .toMatchObject({ actualAt: '2026-11-07T06:00:00Z', actualDate: null });
});

it('Final10 multiple live PO or attempt instances cannot be selected by a kind-wide fact', () => {
  const first = node(), second = { ...node(), instanceId: 'TEST-other-PO' };
  const all = [first, second, { ...node(), instanceId: 'TEST-old-round', round: 1, current: false }];
  expect(journeyNodeFactTarget(all, first.key, 2)).toBeUndefined();
  expect(all.map(value => value.instanceId)).toEqual([first.instanceId, second.instanceId, 'TEST-old-round']);
  expect(journeyNodeFactTarget([first], first.key, 2)).toBe(first);
});
