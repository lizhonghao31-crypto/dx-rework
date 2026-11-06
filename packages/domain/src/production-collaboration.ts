/** Read-only original responsibility intervals. Recording time never fills a
 * missing business boundary, and the submitter never replaces the assignee. */
export type CollaborationAssignment={version:number;personId:string|null;effectiveAt:string|null;sourceRef:string};
export type CollaborationInterval={personId:string|null;from:string;to:string|null;sourceRefs:string[]};
export function collaborationAssignments(history:readonly CollaborationAssignment[],currentPersonId:string|null,deadline:string|null,asOf:string){
 const valid=(at:string|null):at is string=>at!==null&&/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(at)&&Number.isFinite(Date.parse(at)),now=valid(asOf)?Date.parse(asOf):NaN;if(!Number.isFinite(now))throw Error('Explicit collaboration observation required');
 const rows=[...history].sort((a,b)=>a.version-b.version),intervals:CollaborationInterval[]=[],unknown:string[]=[];let last:CollaborationAssignment|undefined;
 for(const [index,row]of rows.entries()){
  if(row.version!==index+1||!valid(row.effectiveAt)||!row.sourceRef.trim()||last&&Date.parse(row.effectiveAt)<Date.parse(last.effectiveAt!)){unknown.push('原主办版本链或业务生效边界缺证，不用登记时间补责任期间');break;}
  if(Date.parse(row.effectiveAt)>now)continue;
  if(last)intervals.push({personId:last.personId,from:last.effectiveAt!,to:row.effectiveAt,sourceRefs:[last.sourceRef,row.sourceRef]});last=row;
 }
 if(last&&!unknown.length)intervals.push({personId:last.personId,from:last.effectiveAt!,to:null,sourceRefs:[last.sourceRef]});
 if(!last)unknown.push('尚无完整可核主办期间；当前负荷仍沿当前原主办');
 if(last&&!unknown.length&&last.personId!==currentPersonId)unknown.push('历史链尾与当前原主办不一致，不能任选一方补历史');
 const responsibleAtDeadline=valid(deadline)&&Date.parse(deadline)<=now&&!unknown.length?intervals.find(interval=>Date.parse(interval.from)<=Date.parse(deadline)&&(interval.to===null||Date.parse(deadline)<Date.parse(interval.to)))?.personId??null:null;
 return {currentPersonId,intervals,assigneeAtDeadline:responsibleAtDeadline,unknown,limitation:'截止时主办只说明负责期间，不是原业务已确认过错；实际提交者须另列。'};
}
export type CollaborationProblem={id:string;taskId:string;involvedPersonIds:string[];confirmedPersonIds:string[];decisionId:string|null};
export function collaborationProblems(problems:readonly CollaborationProblem[],comparableTaskIds:readonly string[],coverageComplete:boolean){
 const byId=new Map<string,CollaborationProblem>(),conflicts=new Set<string>();
 for(const original of problems){const problem={...original,involvedPersonIds:[...new Set(original.involvedPersonIds)].sort(),confirmedPersonIds:[...new Set(original.confirmedPersonIds)].sort()},old=byId.get(problem.id);if(old&&JSON.stringify(old)!==JSON.stringify(problem))conflicts.add(problem.id);else byId.set(problem.id,problem);}
 const facts=[...byId.values()].filter(fact=>!conflicts.has(fact.id)),tasks=new Set(comparableTaskIds),problemTasks=new Set(facts.filter(problem=>tasks.has(problem.taskId)).map(problem=>problem.taskId)),people=new Set(facts.flatMap(problem=>[...problem.involvedPersonIds,...(problem.decisionId?problem.confirmedPersonIds:[])]));
 return {globalProblems:byId.size,problemTasks:problemTasks.size,comparableTasks:tasks.size,taskProblemRate:coverageComplete&&!conflicts.size&&tasks.size?problemTasks.size/tasks.size:null,unknown:[...conflicts].map(id=>'同原问题有矛盾版本：'+id),people:[...people].sort().map(personId=>({personId,involved:facts.filter(problem=>problem.involvedPersonIds.includes(personId)).length,confirmed:facts.filter(problem=>problem.decisionId&&problem.confirmedPersonIds.includes(personId)&&!conflicts.has(problem.id)).length})),limitation:'多人涉及数不可相加成全局问题数；责任只使用有效原决定，不从参与、备注或代办推定。'};
}
