import type {CockpitDocumentEntry} from './cockpit-document-data.js';
import {journeyTime} from './digital-journey-cockpit-model.js';
export function documentTime(value:string){return /^\d{4}-\d{2}-\d{2}$/.test(value)?value:journeyTime(value);}
export function filterDocumentEntries(entries:CockpitDocumentEntry[],query:string):CockpitDocumentEntry[]{
 const q=query.trim().toLocaleLowerCase();if(!q)return entries;
 return entries.flatMap(entry=>{
  const matches=[entry.label,entry.note,...(entry.files??[]).map(f=>f.name)].some(v=>v?.toLocaleLowerCase().includes(q));
  if(matches)return [entry];const children=filterDocumentEntries(entry.children??[],q);return children.length?[{...entry,children}]:[];
 });
}
export const documentFocusKey=(path:string)=>path.length<=290?path:path.split('/')[0]??'';
