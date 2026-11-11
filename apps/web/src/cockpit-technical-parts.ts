import{technicalDirectory,loadTechnicalEntry}from'./cockpit-documents-technical.js';
import{legacyDevelopmentPart}from'./cockpit-documents-legacy-development.js';
import type{CockpitDocumentReader,CockpitDocumentEntry,CockpitDocumentResult}from'./cockpit-document-data.js';
export type TechnicalPart='plt'|'sizes'|'consumption'|'comment'|'final';
const tagged=(entry:CockpitDocumentEntry,part:TechnicalPart):CockpitDocumentEntry=>({...entry,...(entry.load?{load:{...entry.load,part}}:{})});
export function selectTechnicalPart(entry:CockpitDocumentEntry,part:TechnicalPart):CockpitDocumentEntry{
 if(part==='comment'||part==='final'){
  if(entry.technicalPart===part)return entry;
  return {...entry,children:(entry.children??[]).filter(child=>child.technicalPart===part||child.load?.kind==='technical_history_comments').map(child=>tagged(child,part))};
 }
 // A history page contains lazy exact-version readers, not an artifact body.
 if(entry.children?.some(child=>child.load?.kind==='technical_artifact'||child.load?.kind==='technical_history_artifacts'))return {...entry,children:entry.children.map(child=>tagged(child,part))};
 return {...entry,technicalPart:part,files:part==='plt'?entry.files??[]:[],children:part==='plt'?[]:(entry.children??[]).filter(child=>part==='consumption'?child.id.startsWith('consumption:'):child.id.startsWith('measurement:')||child.load?.kind==='technical_template')};
}
/** Metadata/history retain exact original version readers. Only the current
 * referenced artifact body is needed to identify the three independent parts;
 * snapshot request reuse combines these same-path reads, not user authority. */
export async function technicalPartDirectory(order:Parameters<typeof technicalDirectory>[0],part:TechnicalPart,read:CockpitDocumentReader,signal:AbortSignal,scope='整款'):Promise<CockpitDocumentResult>{
 const directory=await technicalDirectory(order,read,signal,scope,part);if(directory.state==='not_applicable')return directory;
 if(directory.legacy)return legacyDevelopmentPart(directory,part);
 const scoped=directory.entries.filter(entry=>entry.load?.kind==='technical_directory').map(entry=>tagged(entry,part));
 if(part==='comment'||part==='final'){
  const entries=directory.entries.flatMap(entry=>entry.id==='comments'?entry.children??[]:[]).filter(entry=>entry.technicalPart===part||entry.load?.kind==='technical_history_comments').map(entry=>tagged(entry,part));
  return {state:entries.some(entry=>entry.technicalPart===part)?'created':scoped.length?'unknown':'missing',entries:[...entries,...scoped]};
 }
 const artifacts=directory.entries.filter(entry=>entry.load?.kind==='technical_artifact'),current=artifacts[0];
 if(!current)return {state:scoped.length?'unknown':'missing',entries:scoped};
 const loaded=await loadTechnicalEntry(tagged(current,part),read,signal);if(!loaded)throw Error('本版技术成果暂未读取完整');
 const selected=selectTechnicalPart(loaded,part),filled=part==='plt'?Boolean(selected.files?.length):Boolean(selected.children?.length);
 return {state:filled?'created':scoped.length?'unknown':'missing',entries:[{...selected,sourceOnly:!filled},...artifacts.slice(1).map(entry=>({...tagged(entry,part),sourceOnly:true})),...directory.entries.filter(entry=>entry.load?.kind==='technical_history_artifacts').map(entry=>({...tagged(entry,part),sourceOnly:true})),...scoped]};
}
