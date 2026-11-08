import type {JourneyNode,JourneyState} from '@dx-rework/contracts/digital-production-journey';
const dayFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
export const journeyObservedDay=(at:string)=>dayFormatter.format(new Date(at));
/** Legacy tasks without an explicit flag already become overdue at equality. */
export const journeyTaskDeadlineExclusive=(task:{deadlineExclusive?:boolean|undefined})=>task.deadlineExclusive!==false;
/** Original task warning/overdue comparisons, shared by native projection and
 * the lightweight selector compiler; no new SLA or completion rule. */
export function journeyTaskTimeRisks(task:{state:JourneyState;dueAt:string|null;warningAt:string|null;deadlineExclusive?:boolean|undefined},at:string):JourneyNode['risks']{
 if(!['active','blocked'].includes(task.state))return [];
 if(task.dueAt&&(journeyTaskDeadlineExclusive(task)?Date.parse(task.dueAt)<=Date.parse(at):Date.parse(task.dueAt)<Date.parse(at)))return ['overdue'];
 return task.warningAt&&Date.parse(task.warningAt)<=Date.parse(at)?['due_soon']:[];
}
export const journeyPlanDateOverdue=(date:string|null,day:string)=>date!==null&&date<day;
