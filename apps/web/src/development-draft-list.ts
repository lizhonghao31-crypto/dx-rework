import {NUMBERED_DRAFT_PATH} from './development-creation-command-path.js';
import type {CreationDraftRecord} from './development-creation-draft.js';

export type SavedDevelopmentDraft={sourceId:string;designStyleNo:string|null;version:number;updatedAt:string;approvalState:string|null;approvalRequestId?:string|null;temporaryStyleNo?:string|null;
 canDiscard?:boolean;numbered?:boolean;ownedByRequester?:boolean;kind?:'development'|'certain_order'|'preorder'|null};
export type DevelopmentDraftRow=
 |{kind:'saved';saved:SavedDevelopmentDraft;local?:CreationDraftRecord}
 |{kind:'local';local:CreationDraftRecord};

const draftStyle=(record:CreationDraftRecord)=>record.snapshot.form.designStyleNo.trim().toLowerCase();
/** Unconfirmed commands retain their original location/input and are never
 * actionable ordinary rows, even if the server still reads the old draft. */
export function pendingDevelopmentCommands(local:readonly CreationDraftRecord[]){
 return local.filter(record=>record.phase==='pending');
}
export function unboundNumberedDraftKeys(local:readonly CreationDraftRecord[]){
 return pendingDevelopmentCommands(local).flatMap(record=>!record.sourceId&&record.original.path===NUMBERED_DRAFT_PATH?[record.original.key]:[]).sort();
}
export function developmentDraftRows(saved:readonly SavedDevelopmentDraft[], local:readonly CreationDraftRecord[], search:string, page:number,
 numberedReceipts?:{resolvedSourceIds:ReadonlySet<string>;unverified:boolean}):DevelopmentDraftRow[]{
 const pending=pendingDevelopmentCommands(local);
 const knownPending=new Set(pending.flatMap(record=>record.sourceId?[record.sourceId]:[]));
 const unboundStyles=new Set(pending.flatMap(record=>!record.sourceId&&draftStyle(record)?[draftStyle(record)]:[]));
 const bound=new Map(local.flatMap(record=>record.phase==='bound'?[[record.sourceId,record]]:[]));
 const query=search.trim().toLowerCase();
 const unverified=numberedReceipts?.unverified??unboundNumberedDraftKeys(local).length>0;
 const rows:DevelopmentDraftRow[]=saved.filter(record=>!knownPending.has(record.sourceId)&&!unboundStyles.has(record.designStyleNo?.trim().toLowerCase()??'')
   &&!numberedReceipts?.resolvedSourceIds.has(record.sourceId)&&!(unverified&&record.numbered!==false&&record.ownedByRequester!==false)).map(record=>{
  const draft=bound.get(record.sourceId);
  return {kind:'saved',saved:record,...(draft?{local:draft}:{})};
 });
 // Bound snapshots can only augment a known ordinary, authorized server row.
 // They must not recreate a deleted, published or paginated-away source.
 if(page===1)for(const draft of local)if(draft.phase==='draft'&&draftStyle(draft).includes(query))rows.push({kind:'local',local:draft});
 return rows;
}
