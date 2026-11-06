/** Read-only personnel facts, never authority to assign or determine liability. */
export type CollaborationPerson={id:string;name:string};
export type CollaborationTask={
 taskId:string;orderId:string;lineIds:string[];nodeKey:string;label:string;role:string;state:string;
 currentLoad:boolean;currentAssignee:CollaborationPerson|null;
 intervals:Array<{person:CollaborationPerson|null;from:string;to:string|null;sourceRefs:string[]}>;
 assigneeAtDeadline:CollaborationPerson|null;deadline:string|null;deadlineExclusive:boolean;deadlinePending:boolean;deadlineExplanation:string;
 handlers:Array<{eventId:string;kind:string;person:CollaborationPerson;occurredAt:string|null;recordedAt:string;verified:boolean}>;
 problems:Array<{id:string;kind:string;state:string;involved:CollaborationPerson[];sourceRefs:string[]}>;
 waitingSeconds:number;waitingCoverage:'complete'|'partial'|'unknown';unknown:string[];sourceRefs:string[];
};
export type ProductionCollaboration={asOf:string;scopeUnknown:Array<{orderId:string;lineId:string|null;reason:string}>;tasks:CollaborationTask[];nodeSummary:Array<{role:string;nodeKey:string;label:string;currentTasks:number;currentOverdueTasks:number;currentDeadlineUnknownTasks:number;unassignedTasks:number;currentTaskIds:string[];currentOverdueTaskIds:string[]}>;summary:Array<{person:CollaborationPerson;role:string;nodeKey:string;currentTasks:number;currentOverdueTasks:number;currentDeadlineUnknownTasks:number;currentTaskIds:string[];currentOverdueTaskIds:string[];handledTasks:number;involvedProblems:number;involvedTasks:number;scopeTasks:number;problemTaskRate:number|null}>;globalProblemCount:number;unattributedProblems:Array<{id:string;orderId:string;lineIds:string[];kind:string;sourceRefs:string[]}>;personalResponsibility:{available:false;reason:string};limitations:string[]};
