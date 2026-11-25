import {describe,expect,it} from 'vitest';
import type {SecondaryCraftList} from '@dx-rework/contracts/secondary-craft-quotation';
import {craftDirectoryRowKey,pageAuthorizedCraftDirectory,readCraftDirectoryView,writeCraftDirectoryView} from '../../apps/web/src/secondary-craft-directory-view.js';

type Row=SecondaryCraftList['items'][number];
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const row=(index:number,patch:Partial<Row>={}):Row=>({resource:{kind:'order',id:id(1)},rowId:id(index),styleNo:'TEST-20261125',label:'绣花',round:1,stage:'bulk',sourceVersion:1,version:2,state:'returned',authorName:null,supplier:null,note:null,canDecide:false,approvalTodoId:null,submittedAt:null,...patch});

describe('C4 secondary craft directory view stays within the original authorized rows',()=>{
 it('filters before slicing, retains same-order individual craft rows and native order',()=>{
  const rows=[...Array.from({length:15},(_,i)=>row(i+2,{label:'印花',state:'approved'})),...Array.from({length:16},(_,i)=>row(i+40))];
  const query={search:'test-20261125',state:'returned' as const,craft:'绣花',page:2};
  expect(pageAuthorizedCraftDirectory(rows,query)).toMatchObject({total:16,totalPages:2,page:2,items:[rows[30]]});
  expect(pageAuthorizedCraftDirectory(rows,{...query,page:1}).items.map(craftDirectoryRowKey)).toEqual(rows.slice(15,30).map(craftDirectoryRowKey));
  expect(pageAuthorizedCraftDirectory(rows,{...query,search:'不在授权集',page:2})).toEqual({total:0,totalPages:1,page:1,items:[]});
 });
 it('preserves filters, page and exact return row independently of detail version',()=>{
  const value={search:'TEST-20261125',state:'returned' as const,craft:'绣花',page:2,focus:craftDirectoryRowKey(row(40))};
  const params=writeCraftDirectoryView(value);params.set('version','6');
  expect(readCraftDirectoryView(params)).toEqual(value);
  params.append('craftPage','3');params.set('craftFocus','//remote.invalid');params.set('craftState','not-a-state');
  expect(readCraftDirectoryView(params)).toEqual({search:value.search,state:'all',craft:'绣花',page:1});
 });
});
