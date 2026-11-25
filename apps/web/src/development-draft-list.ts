import type {CreationDraftRecord} from './development-creation-draft.js';

export type SavedDevelopmentDraft={sourceId:string;designStyleNo:string|null;version:number;updatedAt:string;approvalState:string|null;
 canDiscard?:boolean;kind?:'development'|'certain_order'|'preorder'|null};
export type DevelopmentDraftRow=
 |{kind:'saved';saved:SavedDevelopmentDraft;local?:CreationDraftRecord}
 |{kind:'local';local:CreationDraftRecord};

/** The server page and total stay authoritative. Local recovery participates in
 * the same search and list without becoming a second server row or page count. */
export function developmentDraftRows(saved:readonly SavedDevelopmentDraft[], local:readonly CreationDraftRecord[], search:string, page:number):DevelopmentDraftRow[]{
 const bySource=new Map<string,CreationDraftRecord>();
 for(const record of local){
  if(record.phase==='draft'||!record.sourceId)continue;
  if(!bySource.has(record.sourceId)||record.phase==='pending')bySource.set(record.sourceId,record);
 }
 const query=search.trim().toLowerCase();
 const matched=new Set(saved.map(record=>record.sourceId));
 const rows:DevelopmentDraftRow[]=saved.map(record=>{
  const draft=bySource.get(record.sourceId);
  return {kind:'saved',saved:record,...(draft?{local:draft}:{})};
 });
 for(const draft of local){
  if(draft.phase!=='draft'&&draft.sourceId&&(matched.has(draft.sourceId)||bySource.get(draft.sourceId)!==draft))continue;
  // A pending result must be recoverable even while an unrelated search or
  // server page is open. Ordinary unmatched local drafts sit on the first page.
  if(draft.phase!=='pending'&&(page!==1||!draft.snapshot.form.designStyleNo.toLowerCase().includes(query)))continue;
  rows.push({kind:'local',local:draft});
 }
 return rows;
}
