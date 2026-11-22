import type {SeriesMilestoneKey,SeriesRoute} from './digital-series-plan.js';
import type {ScheduleGoalDelta,ScheduleOccurrence,ScheduleCompletionEstimate} from './fixed-schedule-progress.js';
/** Authorized read-only projection. Work IDs refer to existing instances;
 * milestone membership never creates another task or progress share. */
export type JourneyFrameworkMilestone={key:SeriesMilestoneKey;targetDate:string|null;plannedAt:string|null;workIds:string[];relatedWorkIds?:string[];completed:boolean;actual:ScheduleOccurrence;delta:ScheduleGoalDelta;forecast:ScheduleCompletionEstimate;feasibility:'sufficient'|'insufficient'|'unknown'|'terminated';lateMinutes:number|null;coverage:string[]};
export type JourneyFrameworkScope={scopeRef:string;lineId:string|null;route:SeriesRoute;reference:string;revision:number;effectiveAt:string;customerDate:string;milestones:JourneyFrameworkMilestone[]};
export type JourneyTimeFramework={version:'journey-time-framework-v1';asOf:string;scopes:JourneyFrameworkScope[];applicableWork:number;completedWork:number};
