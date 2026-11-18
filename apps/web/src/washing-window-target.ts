import {bulkWashingWindowReference,BulkWashingWindowReferenceSchema,type BulkWashingSheet,type BulkWashingScopeView} from '@dx-rework/contracts/bulk-washing';
import type {JourneyNode,JourneyTiming} from '@dx-rework/contracts/digital-production-journey';

type NativeWindow=NonNullable<JourneyTiming['windows']>[number];
/** Only identical representations of the same native evidence can coalesce.
 * Template labels, PO, null round and array position never identify a window. */
export function washingWindowChoices(windows:readonly NativeWindow[]){
 const groups=new Map<string,NativeWindow[]>();
 for(const window of windows)groups.set(window.evidence,[...groups.get(window.evidence)??[],window]);
 const signature=(window:NativeWindow)=>JSON.stringify([window.scopeLabel,window.startedAt,window.deadline,window.warningAt,window.completedAt,window.complete,window.snapshotId??null,window.record?[window.record.domain,window.record.id,window.record.url,window.record.mode,window.record.lineId,window.record.version]:null]);
 return [...groups].map(([evidence,rows])=>({evidence,window:new Set(rows.map(signature)).size===1?rows[0]!:null}));
}
export function selectCockpitWashingWindow(nodes:readonly JourneyNode[],instanceId:string|undefined,focus:string|undefined){
 const reference=focus?.startsWith('washing-window:')?focus.slice('washing-window:'.length):null;
 const invalid=(error:string)=>({reference,node:null,error});
 if(reference===null)return {reference:null,node:null,error:null};
 if(!BulkWashingWindowReferenceSchema.safeParse(reference).success)return invalid('原洗水窗口标识无效，指定目标已保留，请从原记录重新进入');
 const candidates=nodes.filter(node=>(!instanceId||node.instanceId===instanceId)&&node.state!=='unavailable'&&node.unavailableReason!=='permission'&&node.nativeWindows?.some(window=>window.evidence===reference));
 if(candidates.length!==1)return invalid('原洗水窗口不在当前可见范围或身份不唯一，指定目标已保留，请核对原范围和权限');
 const selected=washingWindowChoices(candidates[0]!.nativeWindows??[]).find(choice=>choice.evidence===reference);
 if(!selected?.window?.record||selected.window.record.mode!=='read')return invalid('原洗水窗口资料冲突或尚不可读取，指定目标已保留');
 return {reference,node:candidates[0]!,error:null};
}

export type WashingWindowTarget={lineId:string|null;reference:string|null;factoryId?:string|undefined};
export type WashingWindowSelection={error:string|null;scope:BulkWashingScopeView|null;window:BulkWashingScopeView['windows'][number]|null};
/** A URL locates only an exact member of the original authorized read result. */
export function selectWashingWindow(sheet:BulkWashingSheet,orderId:string,target:WashingWindowTarget):WashingWindowSelection{
 const invalid=(error:string):WashingWindowSelection=>({error,scope:null,window:null});
 if(sheet.orderId!==orderId||target.factoryId&&target.factoryId!==orderId)return invalid('洗水窗口不属于当前母单，请从原窗口重新进入');
 const scopes=sheet.scopes.filter(scope=>!target.lineId||scope.lineId===target.lineId);
 if(target.lineId&&!scopes.length)return invalid('本单可见洗水资料中没有指定PO范围，请核对原入口和当前权限');
 if(!target.reference)return {error:null,scope:null,window:null};
 if(!target.lineId)return invalid('精确洗水窗口缺少PO范围，请从原窗口重新进入');
 const matches=scopes.flatMap(scope=>scope.windows.filter(window=>bulkWashingWindowReference(scope.scopeId,window.id)===target.reference).map(window=>({scope,window})));
 return matches.length===1?{error:null,...matches[0]!}:invalid(matches.length?'本窗口身份不唯一，请核实原记录':'本单指定PO中没有此可见洗水窗口，原目标已保留，请核对范围和权限');
}

/** Native event pointers associate the original start, completion and checks.
 * Inspection IDs are compared in their original whole form, not colon-split. */
export function washingWindowFacts(scope:BulkWashingScopeView,window:BulkWashingScopeView['windows'][number]){
 const completions=scope.facts.filter(fact=>fact.kind==='return'||fact.kind==='factory_complete').filter(fact=>window.kind==='inspection'?`${fact.id}:qc`===window.id:fact.kind==='return'?fact.sendId===window.id:fact.startId===window.id);
 const starts=new Set(completions.map(fact=>fact.kind==='return'?fact.sendId:fact.kind==='factory_complete'?fact.startId:''));
 if(window.kind==='washing')starts.add(window.id);
 const completionIds=new Set(completions.map(fact=>fact.id));
 return scope.facts.filter(fact=>starts.has(fact.id)||completionIds.has(fact.id)||fact.kind==='inspection'&&completionIds.has(fact.completionId)||fact.kind==='receipt_link'&&completionIds.has(fact.completionId));
}
export const washingWindowDomId=(reference:string)=>'washing-window-'+encodeURIComponent(reference);
