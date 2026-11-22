import type {TimeFrameworkInput} from '@dx-rework/contracts/order-time-framework';
import {evaluateTimeFrameworkCandidate,type FrameworkCandidateContext} from './order-time-framework.js';

type ScopeProposal={input:TimeFrameworkInput;retained?:FrameworkCandidateContext['retained'];adoptedMilestones?:FrameworkCandidateContext['adoptedMilestones'];materialInvestmentResolutionRef?:string};
/** Shared submission calculation only: no authority, persistence or actual-event
 * writer. The original command must reread inputs under its transaction, check
 * its own permission/CAS and supply the submission observation. Preview results
 * and client-supplied permission flags cannot authorize adoption through here. */
export function evaluateFrameworkSubmission(input:{scopes:readonly ScopeProposal[];observedAt:string;
 mode:'automatic'|'adjustment';acceptLate:boolean}){
 if(!['automatic','adjustment'].includes(input.mode))throw Error('本单提交方式无效');
 if(!input.scopes.length)throw Error('缺少本单适用范围');
 if(new Set(input.scopes.map(scope=>scope.input.scopeRef)).size!==input.scopes.length)throw Error('本单适用范围重复');
 const candidates=input.scopes.map(scope=>evaluateTimeFrameworkCandidate(scope.input,
  {purpose:'order_proposal',observedAt:input.observedAt,...(scope.retained?{retained:scope.retained}:{}),...(scope.adoptedMilestones?{adoptedMilestones:scope.adoptedMilestones}:{}),...(scope.materialInvestmentResolutionRef?{materialInvestmentResolutionRef:scope.materialInvestmentResolutionRef}:{})}));
 const gaps=candidates.flatMap(candidate=>candidate.milestones.filter(row=>row.status==='insufficient')
  .map(row=>({scopeRef:candidate.input.scopeRef,key:row.key,date:row.date!,lateMinutes:row.lateMinutes!,workIds:row.blockingWorkIds})));
 const missing=candidates.flatMap(candidate=>{
  const work=candidate.arranged.filter(row=>candidate.coverage.includes(row.id)).map(row=>({scopeRef:candidate.input.scopeRef,
   workId:row.id,reasons:[...new Set([...row.start.reasons,...row.end.reasons])]}));
  return work;
 });
 const incomplete=missing.length>0||candidates.some(candidate=>candidate.milestones.some(row=>!row.planned.at));
 const action=incomplete?'complete_inputs':gaps.length===0?'adopt':input.mode==='automatic'?'request_adjustment':input.acceptLate===true?'adopt':'confirm_gap';
 // Keep per-scope and intermediate gaps; neither spare time on another PO nor
 // acceptance of risk erases them. Final delivery is an independent summary.
 const delivery=candidates.map(candidate=>{
  const row=candidate.milestones.find(milestone=>milestone.key==='planned_shipment')!;
  return {scopeRef:candidate.input.scopeRef,date:row.date!,status:row.status,lateMinutes:row.lateMinutes};
 });
 return {action,candidates,gaps,missing,delivery,riskAccepted:action==='adopt'&&gaps.length>0};
}
