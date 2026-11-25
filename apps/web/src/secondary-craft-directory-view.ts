import type {SecondaryCraftList} from '@dx-rework/contracts/secondary-craft-quotation';
import {LIST_PAGE_SIZE} from '@dx-rework/contracts/reporting';

type CraftRow=SecondaryCraftList['items'][number];
const states=['all','pending','draft','submitted','approved','returned'] as const;
type CraftState=(typeof states)[number];
export type CraftDirectoryView={search:string;state:CraftState;craft:string;page:number;focus?:string};

export const craftDirectoryRowKey=(row:CraftRow)=>`${row.resource.kind}:${row.resource.id}:${row.rowId}`;
const focusIdentity=/^(?:source|order):[a-f0-9-]{36}:[a-f0-9-]{36}$/i;

// The view contains only query and return state. It cannot carry a URL or grant access.
export function readCraftDirectoryView(params:URLSearchParams):CraftDirectoryView{
 const read=(name:string)=>params.getAll(name).length===1?params.get(name)??'':'';
 const state=states.find(value=>value===read('craftState'))??'all',rawPage=read('craftPage'),focus=read('craftFocus');
 const page=/^[1-9]\d{0,5}$/.test(rawPage)?Number(rawPage):1;
 return {search:read('craftSearch').trim().slice(0,100),state,craft:read('craftType').trim().slice(0,100),page,...(focusIdentity.test(focus)?{focus}:{})};
}

export function writeCraftDirectoryView(view:CraftDirectoryView){
 const params=new URLSearchParams();
 if(view.search.trim())params.set('craftSearch',view.search.trim());
 if(view.state!=='all')params.set('craftState',view.state);
 if(view.craft)params.set('craftType',view.craft);
 if(view.page>1)params.set('craftPage',String(view.page));
 if(view.focus)params.set('craftFocus',view.focus);
 return params;
}

/** Project the entire result of the existing authorized directory before paging.
 * Multiple craft lines under the same order stay independent. Preserve native order. */
export function pageAuthorizedCraftDirectory(rows:readonly CraftRow[],view:CraftDirectoryView){
 const keyword=view.search.trim().toLocaleLowerCase('zh-CN');
 const matching=rows.filter(row=>(view.state==='all'||row.state===view.state)&&(!view.craft||row.label===view.craft)&&
  (!keyword||[row.resource.id,row.styleNo,row.label,row.customerCode??'',...(row.formalPoNos??[])].some(value=>value.toLocaleLowerCase('zh-CN').includes(keyword))));
 const total=matching.length,totalPages=Math.max(1,Math.ceil(total/LIST_PAGE_SIZE)),page=Math.min(view.page,totalPages);
 return {total,totalPages,page,items:matching.slice((page-1)*LIST_PAGE_SIZE,page*LIST_PAGE_SIZE)};
}
