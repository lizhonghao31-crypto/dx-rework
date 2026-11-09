import {createHash} from 'node:crypto';
export const canonicalTimelineInput=(value:unknown):unknown=>Array.isArray(value)?value.map(canonicalTimelineInput):value&&typeof value==='object'
 ?Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b,'en')).map(([key,value])=>[key,canonicalTimelineInput(value)])):value;
export const fixedTimelineIdentity=(input:unknown)=>createHash('sha256').update(JSON.stringify(canonicalTimelineInput(input))).digest('hex');
