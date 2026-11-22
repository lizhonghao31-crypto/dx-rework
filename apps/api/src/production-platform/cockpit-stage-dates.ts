import {COCKPIT_MILESTONE_GROUP, JOURNEY_STAGES, type CockpitStageDateScope, type CockpitStageDates} from '@dx-rework/contracts/digital-production-journey';
import {SERIES_MILESTONES} from '@dx-rework/contracts/digital-series-plan';
import type {ScheduleOccurrence} from '@dx-rework/contracts';
import type {JourneyTimeFramework} from '@dx-rework/contracts/time-framework-journey';
import type {FixedScheduleBasis} from './fixed-schedule-basis.js';
import {fixedScheduleStages} from './fixed-schedule-stages.js';

const unknown: ScheduleOccurrence = {precision: 'unknown'};

/** Derive the detail display from the authorized snapshot already used by the
 * order. Neither these dates nor the display grouping feed the SLA evaluator. */
export function cockpitStageDates(basis: FixedScheduleBasis, framework: JourneyTimeFramework): CockpitStageDateScope[] {
  return framework.scopes.flatMap(plan => {
    const matches = basis.scopes.filter(scope => scope.scopeRef === plan.scopeRef && scope.lineId === plan.lineId);
    if (matches.length !== 1 || framework.scopes.filter(scope => scope.scopeRef === plan.scopeRef).length !== 1) return [];
    const scope = matches[0]!;
    const completedStages = new Set<number>();
    const original = fixedScheduleStages({...basis, scopes: [scope], scopeRevision: scope.targetRevision}, framework.asOf,
      (stage, complete) => { if (complete) completedStages.add(stage); });
    const stages = JOURNEY_STAGES.map(({key}, index): CockpitStageDates => {
      const stage = original.find(value => value.stage === index + 1);
      const applicable = SERIES_MILESTONES.filter(value => COCKPIT_MILESTONE_GROUP[value.key] === key
        && (value.key !== 'color_confirmation' || plan.route === 'A'));
      const targets = applicable.map(({key: milestoneKey}) => {
        const rows = plan.milestones.filter(milestone => milestone.key === milestoneKey);
        return {key: milestoneKey, date: rows.length === 1 ? rows[0]!.targetDate : null};
      });
      const missingTargets = targets.filter(target => !target.date).map(target => target.key);
      const dates = targets.flatMap(target => target.date ? [target.date] : []);
      const latest = !missingTargets.length ? dates.sort().at(-1) : undefined;
      const expected: ScheduleOccurrence = applicable.length
        ? latest ? {precision: 'date', date: latest} : unknown
        : stage?.expected ?? unknown;
      const goal = stage?.goalDelta ?? null;
      const comparable = Boolean(goal && (goal.targetAt || goal.targetDate));
      const sameDate = goal && (expected.precision === 'date'
        ? goal.targetPrecision === 'date' && goal.targetDate === expected.date
        : expected.precision === 'instant' && goal.targetPrecision === 'instant' && goal.targetAt === expected.at);
      return {key, expected, expectedSource: applicable.length ? 'milestone_targets' : 'stage_schedule',
        missingTargets, actual: stage?.actual ?? unknown, actualComplete: completedStages.has(index+1), goalDelta: goal,
        differenceUsesOriginalTarget: comparable && (!sameDate || goal?.targetRevision !== scope.targetRevision)};
    });
    const milestoneMembers = plan.milestones.map(milestone => {
      const ids = new Set(milestone.workIds);
      // Include work that is carried by a direct member, but do not count the
      // rest of the predecessor closure as direct milestone members.
      for (const work of scope.work) if (work.includedIn && ids.has(work.includedIn)) ids.add(work.id);
      return {key: milestone.key, workIds: [...ids],
        prerequisiteIds: (milestone.relatedWorkIds ?? []).filter(id => !ids.has(id))};
    });
    return [{scopeRef: plan.scopeRef, planReference: plan.reference, planRevision: plan.revision, stages, milestoneMembers}];
  });
}
