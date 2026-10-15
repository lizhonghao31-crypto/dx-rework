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
const taskState={ready:'可办理',completed:'已完成',pending:'等待前置',blocked:'受阻',cancelled:'已取消'};
export function BulkPatternWorkspace({orderId,canViewAll,onOrderChange}:{orderId:string|null;canViewAll:boolean;onOrderChange?:(orderId:string|null)=>void}){
 const [selected,setSelected]=useState(orderId),[filter,setFilter]=useState(()=>initialFilter(canViewAll));
 const [search,setSearch]=useState(filter.search),[data,setData]=useState<BulkWorkroomResult|null>(null),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
 useEffect(()=>setSelected(orderId),[orderId]);
 useEffect(()=>{let live=true;setData(null);setError('');
  void digitalRequest<BulkWorkroomResult>(`workspaces/bulk-pattern?${new URLSearchParams({scope:filter.scope,page:String(filter.page),search:filter.search})}`).then(value=>{if(live)setData(value);}).catch(reason=>{if(live)setError(reason.message);});
  return()=>{live=false;};
 },[filter,refresh]);
 const persist=(next:BulkWorkroomFilter,id:string|null)=>{
  const query=new URLSearchParams({section:'bulk',scope:next.scope,page:String(next.page),search:next.search});if(id)query.set('bulkOrder',id);
  window.history.replaceState(window.history.state,'',`${createWebUrls(import.meta.env.BASE_URL).pageUrl('ui/digital-pattern-room')}?${query}`);
 };
 const update=(patch:Partial<BulkWorkroomFilter>)=>{const next=BulkWorkroomFilterSchema.parse({...filter,page:1,...patch});setFilter(next);persist(next,selected);};
 const choose=(id:string|null)=>{setSelected(id);onOrderChange?.(id);persist(filter,id);};
 return <section className="dx-production-panel bulk-pattern-workspace" aria-label="大货纸样与唛架岗位任务">
  <header className="pattern-board-title"><h2>大货纸样与唛架</h2><span>{data?`${data.total} 张大货订单`:'读取中…'}</span><Button type="button" onClick={()=>setRefresh(value=>value+1)}>刷新</Button></header>
  <nav className="development-tabs" aria-label="大货任务范围"><button aria-pressed={filter.scope==='mine'} onClick={()=>update({scope:'mine'})}>我的大货任务</button>{canViewAll&&<button aria-pressed={filter.scope==='all'} onClick={()=>update({scope:'all'})}>全部进度</button>}</nav>
  <form className="pattern-keyword-search" onSubmit={event=>{event.preventDefault();update({search:search.trim()});}}><label>关键词<input placeholder="款号 / PO / 客户 / 当前主办人" maxLength={100} value={search} onChange={event=>setSearch(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&event.nativeEvent.isComposing)event.preventDefault();}}/></label><Button type="submit">查询</Button></form>
  {error&&<p role="alert">{error}</p>}{!data&&!error&&<p role="status">读取真实大货任务…</p>}{data&&!data.items.length&&<p>当前范围暂无大货任务</p>}
  <div className="development-table-scroll bulk-workroom-list"><table className="pattern-role-task-table"><thead><tr><th>母单 / PO / 客户</th><th>采用轮次 / 有效制单</th><th>纸样主办 / 状态 / 截止</th><th>纸样 / 唛架事实</th><th>前置情况</th><th>办理</th></tr></thead><tbody>{data?.items.map(item=><tr key={item.orderId} aria-selected={selected===item.orderId}>
   <td><strong>{item.designStyleNo}</strong><small>母单 {item.orderId}</small><small>{item.customer||'客户未登记'}</small>{item.sheet.cutting.lines.map(line=><small key={line.lineId}>{line.formalStyleNo||line.temporaryStyleNo||'款号未登记'} / {line.poNumber||'PO未登记'} · {line.color}</small>)}</td>
   <td><small>采用轮次：{item.sheet.adoptedRound==null?'未登记':`第 ${item.sheet.adoptedRound} 轮`}</small><small>当前开发：{item.sheet.sourceRound==null?'未登记':`第 ${item.sheet.sourceRound} 轮`}</small><small>{item.sheet.instructionValid?`有效制单 V${item.sheet.instructionVersion}`:item.sheet.instructionVersion?`制单 V${item.sheet.instructionVersion}（当前失效）`:'尚无有效制单'}</small></td>
   <td>{item.sheet.tasks.filter(task=>task.taskKind==='bulk_pattern').map(task=><div key={task.taskId}><small>{task.assigneeName||'待派交'} · {taskState[task.state]}</small><small>截止 {task.dueAt?new Date(task.dueAt).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai',hour12:false}):task.state==='pending'?'尚未启动':'未设时限'}</small></div>)}{!item.sheet.tasks.some(task=>task.taskKind==='bulk_pattern')&&<small>尚未生成纸样任务</small>}</td>
   <td>{['纸样完成','唛架完成'].map(kind=><small key={kind}>{kind}：{item.sheet.facts.some(fact=>fact.kind===kind)?'已登记':'未登记'}</small>)}</td>
   <td>{item.sheet.reasons.join('；')||'无已记录阻断'}</td><td><Button type="button" onClick={()=>{const task=item.sheet.tasks.find(t=>t.taskKind==='bulk_pattern');if(task)window.location.assign(`${createWebUrls(import.meta.env.BASE_URL).pageUrl('ui/digital-production')}?task=${task.taskId}&returnTo=${encodeURIComponent(window.location.pathname+window.location.search)}`);else choose(item.orderId);}}>{item.sheet.canDispatchPattern?'派交 / 查看实际完成':'办理 / 查看纸样与唛架'}</Button></td>
  </tr>)}</tbody></table></div>
  <Pagination page={filter.page} pageSize={15} total={data?.total??null} onPage={page=>update({page})}/>
  {selected&&<section className="bulk-workroom-detail"><a href={`${createWebUrls(import.meta.env.BASE_URL).pageUrl('ui/digital-cockpit')}?selected=${selected}`}>查看这张订单的七大阶段</a><BulkPreparationPanel key={`${selected}:${refresh}`} orderId={selected} onClose={()=>{choose(null);setRefresh(value=>value+1);}}/></section>}
 </section>;
}
