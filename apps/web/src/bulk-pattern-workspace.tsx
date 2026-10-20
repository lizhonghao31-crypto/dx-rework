import {useLiveSearch} from "./use-live-search.js";
import {DigitalReadFailure} from './digital-read-failure.js';
import {PatternBoardLane} from "./pattern-board-parts.js";
import {bulkPatternLane,bulkPatternLanes} from "./bulk-pattern-model.js";
import {BulkPatternCard} from "./bulk-pattern-card.js";
import {useEffect,useState} from "react";
import {Button} from "@dx-rework/ui";
import {Pagination} from "@dx-rework/ui/production";
import {BulkWorkroomFilterSchema,type BulkWorkroomFilter,type BulkWorkroomResult} from "@dx-rework/contracts/bulk-preparation";
import {digitalRequest} from "./digital-production-api.js";
import {BulkPreparationPanel} from "./bulk-preparation-panel.js";
import {createWebUrls} from "../url-contract.js";

function initialFilter(canViewAll:boolean):BulkWorkroomFilter {
 const query=new URLSearchParams(window.location.search);
 const parsed=BulkWorkroomFilterSchema.safeParse({page:query.get('page')??1,search:query.get('search')??'',scope:query.get('scope')??(canViewAll?'all':'mine')});
 return parsed.success?parsed.data:BulkWorkroomFilterSchema.parse({scope:canViewAll?'all':'mine'});
}
export function BulkPatternWorkspace({orderId,canViewAll,onOrderChange}:{orderId:string|null;canViewAll:boolean;onOrderChange?:(orderId:string|null)=>void}){
 const [selected,setSelected]=useState(orderId),[filter,setFilter]=useState(()=>initialFilter(canViewAll));
 const [search,setSearch]=useState(filter.search),[data,setData]=useState<BulkWorkroomResult|null>(null),[error,setError]=useState<Error|null>(null),[refresh,setRefresh]=useState(0),[listRetry,setListRetry]=useState(0);
 const liveSearch=useLiveSearch(search,filter.search,value=>update({search:value}));
 useEffect(()=>setSelected(orderId),[orderId]);
 useEffect(()=>{let live=true;const abort=new AbortController();setData(null);setError(null);if(liveSearch.pending)return()=>{live=false;abort.abort();};
  void digitalRequest<BulkWorkroomResult>(`workspaces/bulk-pattern?${new URLSearchParams({scope:filter.scope,page:String(filter.page),search:filter.search})}`,"GET",undefined,undefined,{signal:abort.signal}).then(value=>{if(live)setData(value);}).catch(reason=>{if(live)setError(reason);});
  return()=>{live=false;abort.abort();};
 },[filter,refresh,listRetry,liveSearch.pending]);
 const persist=(next:BulkWorkroomFilter,id:string|null)=>{
  const query=new URLSearchParams({section:'bulk',scope:next.scope,page:String(next.page),search:next.search});if(id)query.set('bulkOrder',id);
  window.history.replaceState(window.history.state,'',`${createWebUrls(import.meta.env.BASE_URL).pageUrl('ui/digital-pattern-room')}?${query}`);
 };
 const update=(patch:Partial<BulkWorkroomFilter>)=>{const next=BulkWorkroomFilterSchema.parse({...filter,page:1,...patch});setFilter(next);persist(next,selected);};
 const choose=(id:string|null)=>{setSelected(id);onOrderChange?.(id);persist(filter,id);};
 return <section className="dx-production-panel bulk-pattern-workspace" aria-label="大货纸样与唛架岗位任务">
  <header className="pattern-board-title"><h2>大货纸样与唛架</h2><span>{data?`${data.total} 张大货订单`:error?'读取失败':'读取中…'}</span><Button type="button" onClick={()=>setRefresh(value=>value+1)}>刷新</Button></header>
  <nav className="development-tabs" aria-label="大货任务范围"><button aria-pressed={filter.scope==='mine'} onClick={()=>update({scope:'mine'})}>我的大货任务</button>{canViewAll&&<button aria-pressed={filter.scope==='all'} onClick={()=>update({scope:'all'})}>全部进度</button>}</nav>
  <form className="pattern-keyword-search" onSubmit={event=>{event.preventDefault();update({search:search.trim()});}}><label>关键词<input placeholder="款号 / PO / 客户 / 当前主办人" maxLength={100} value={search} onCompositionStart={liveSearch.onCompositionStart} onCompositionEnd={liveSearch.onCompositionEnd} onChange={event=>setSearch(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&event.nativeEvent.isComposing)event.preventDefault();}}/></label></form>
  {error&&<DigitalReadFailure error={error} onRetry={()=>setListRetry(value=>value+1)} retryLabel="重试读取大货任务"/>}{!data&&!error&&<p role="status">读取真实大货任务…</p>}{data&&!data.items.length&&<p>当前范围暂无大货任务</p>}
  <p className="journey-muted">分栏数量为本页记录；办理中表示已派交，不代表已实际开工。纸样与唛架两项完成不等于整单完成。</p>
  <div className="pattern-board-scroll" role="region" aria-label="大货纸样与唛架看板" tabIndex={0}><div className="pattern-board-columns bulk-pattern-columns">{bulkPatternLanes.map(lane=><PatternBoardLane key={lane.key} lane={lane.color} title={lane.label} count={data?data.items.filter(item=>bulkPatternLane(item.sheet)===lane.key).length:'—'}>{data?.items.filter(item=>bulkPatternLane(item.sheet)===lane.key).map(item=>{
   const task=item.sheet.tasks.find(t=>t.taskKind==='bulk_pattern');
   return <BulkPatternCard key={item.orderId} item={item} href={`${createWebUrls(import.meta.env.BASE_URL).pageUrl('ui/digital-production')}?${task?`task=${task.taskId}`:`bulk=${item.orderId}`}&returnTo=${encodeURIComponent(window.location.pathname+window.location.search)}`}/>;
  })}{data&&!data.items.some(item=>bulkPatternLane(item.sheet)===lane.key)&&<p>本页无此类记录</p>}</PatternBoardLane>)}</div></div>
  {!error&&<Pagination page={filter.page} pageSize={15} total={data?.total??null} onPage={page=>update({page})}/>}
  {selected&&<section className="bulk-workroom-detail"><a href={`${createWebUrls(import.meta.env.BASE_URL).pageUrl('ui/digital-cockpit')}?selected=${selected}`}>查看这张订单的七大阶段</a><BulkPreparationPanel key={`${selected}:${refresh}`} orderId={selected} onClose={()=>{choose(null);setRefresh(value=>value+1);}}/></section>}
 </section>;
}
