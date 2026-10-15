import { BusinessTable, FilterBar, KpiCard, PageHeader, Pagination } from "@dx-rework/ui/production";
import {useState, type CSSProperties, type ReactNode} from "react";
import type {CockpitResult, CockpitRow, CockpitStage} from "@dx-rework/contracts/digital-production-cockpit";
import type {DigitalTask} from "@dx-rework/contracts/digital-production-tasks";
import {digitalTaskTiming} from "@dx-rework/domain/digital-task-deadline";
import {taskTimeProgress} from "./digital-cockpit-model.js";
import {createWebUrls} from "../url-contract.js";
import "./production-command-center-view.css";

export type CommandRisk = "normal" | "attention" | "high" | "overdue" | "unknown";

export type CommandOrder = Readonly<{
  orderNo: string;
  styleNo: string;
  customer: string;
  category: string;
  merchandiser: string;
  designer: string;
  quantity: string;
  deliveryDate: string;
  currentStage: string;
  nodeEnteredAt: string;
  nodeLimit: string;
  nodeDeadline: string;
  nodeRemaining: string;
  nodeRisk: CommandRisk;
  overallRisk: CommandRisk;
  overallRiskText: string;
  reason: string;
  orderType?: string;
  progress?: number;
  styleName?: string;
}>;

export type CommandSummary = Readonly<{
  active: number;
  dueSoon: number;
  highRisk: number;
  overdue: number;
  normal?: number;
  completed?: number;
}>;

type Props = Readonly<{
  summary: CommandSummary;
  orders: readonly CommandOrder[];
  selectedOrderNo: string;
}>;

const riskLabel: Record<CommandRisk, string> = {
  normal: "正常",
  attention: "即将到期",
  high: "高风险",
  overdue: "已超时",
  unknown: "待确认",
};

const RiskBadge = ({ level, children }: { level: CommandRisk; children?: ReactNode }) => (
  <span className={`command-risk command-risk--${level}`}>{children ?? riskLabel[level]}</span>
);

const sideNavigation = ["首页", "生产管理座舱", "开发管理", "大货生产", "实时生产看板", "回货质检", "人员/绩效", "报表中心", "基础资料", "系统设置"] as const;
const detailTabs = ["生产进度", "单据信息", "面辅料", "工艺要求", "尺寸表", "生产记录", "质检记录", "客户评语", "变更记录"] as const;
const flow = [
  ["订单创建", "done"],
  ["设计确认", "done"],
  ["预算确认", "done"],
  ["制单", "done"],
  ["纸样&唛架", "done"],
  ["仓库预缩", "done"],
  ["裁床开裁", "current"],
  ["二次工艺", "future"],
  ["发加工", "future"],
  ["回货质检", "future"],
  ["完成", "future"],
] as const;

const progressFor = (order: CommandOrder, index: number) => order.progress ?? [60, 30, 40, 10][index % 4] ?? 0;

export function ProductionCommandCenterView({ summary, orders, selectedOrderNo }: Props) {
  const selected = orders.find(order => order.orderNo === selectedOrderNo) ?? orders[0];
  if (!selected) return null;
  const selectedIndex = Math.max(0, orders.findIndex(order => order.orderNo === selected.orderNo));
  const selectedProgress = progressFor(selected, selectedIndex);
  const normalCount = summary.normal ?? Math.max(summary.active - summary.dueSoon - summary.overdue, 0);
  const completedCount = summary.completed ?? 0;
  const pendingConfirmationCount = orders.filter(order => order.nodeRisk === "unknown").length;
  const progressStyle = { "--command-progress": `${selectedProgress}%` } as CSSProperties;

  return (
    <div className="production-command-shell">
      <aside className="production-command-sidebar" aria-label="生产管理导航">
        <div className="production-command-brand">
          <strong>DX</strong>
          <span>达兴服装<small>数字生产平台</small></span>
        </div>
        <nav>
          {sideNavigation.map((label, index) => (
            <a key={label} className={label === "生产管理座舱" ? "is-active" : undefined} href={`#side-${index}`}>
              <span className="production-command-nav-icon" aria-hidden="true"><i /></span>
              {label}
            </a>
          ))}
        </nav>
        <div className="production-command-sidebar-footer">
          <span>用数据连接设计</span>
          <span>用数字驱动生产</span>
          <small>FROM DESIGN<br />TO DELIVERY</small>
        </div>
      </aside>

      <section className="production-command-workspace">
        <header className="production-command-topbar">
          <div className="production-command-userbar">
            <span className="production-command-search-icon" aria-hidden="true" />
            <span className="production-command-bell" aria-hidden="true"><i /><b>12</b></span>
            <span className="production-command-avatar">L</span>
            <span><strong>{selected.designer}</strong><small>设计师</small></span>
            <span aria-hidden="true">⌄</span>
          </div>
        </header>

        <main className="production-command-main">
          <section className="production-command-overview-row">
            <div className="production-command-welcome">
              <h1>早上好，{selected.designer}！</h1>
              <p>今天是 2026年9月29日</p>
            </div>
            <div className="production-command-summary" aria-label="订单风险摘要">
              <article><span>全部订单</span><strong>{summary.active}</strong><small>当前监控</small></article>
              <article><span>正常进行</span><strong>{normalCount}</strong><small>节点正常</small></article>
              <article><span>即将到期</span><strong>{summary.dueSoon}</strong><small>24小时内</small></article>
              <article><span>已超时</span><strong>{summary.overdue}</strong><small>节点期限已过</small></article>
              <article><span>已完成</span><strong>{completedCount}</strong><small>当前批次</small></article>
            </div>
            <aside className="production-command-today-alerts">
              <h2>▲ 今日待处理</h2>
              <ul>
                <li><span>超时任务</span><strong>{summary.overdue}</strong></li>
                <li><span>即将到期（24小时内）</span><strong>{summary.dueSoon}</strong></li>
                <li><span>高风险订单</span><strong>{summary.highRisk}</strong></li>
                <li><span>待确认节点</span><strong>{pendingConfirmationCount}</strong></li>
              </ul>
            </aside>
          </section>

          <section className="production-command-card production-command-orders-card">
            <div className="production-command-order-tabs">
              {["全部订单", "开发打样", "待确认下单", "大货生产", "回货质检", "已完成"].map((label, index) => (
                <button key={label} className={index === 0 ? "is-active" : undefined} type="button">{label}{index === 0 ? `（${summary.active}）` : ""}</button>
              ))}
            </div>
            <div className="production-command-toolbar">
              <input aria-label="搜索订单" placeholder="搜索款号 / 客户 / 订单号 / 款名" />
              <select aria-label="客户筛选" defaultValue="all"><option value="all">客户</option></select>
              <select aria-label="订单类型筛选" defaultValue="all"><option value="all">订单类型</option></select>
              <select aria-label="节点筛选" defaultValue="all"><option value="all">当前节点</option></select>
              <select aria-label="风险筛选" defaultValue="all"><option value="all">风险状态</option></select>
              <select aria-label="交货时间筛选" defaultValue="all"><option value="all">交货时间</option></select>
              <button className="production-command-more-filter" type="button"><span className="production-command-filter-icon" aria-hidden="true" />更多筛选</button>
              <button className="production-command-new-order" type="button">＋ 新建订单</button>
              <button className="production-command-more-button" type="button">•••</button>
            </div>

            <div className="production-command-table-wrap">
              <table className="production-command-table">
                <thead><tr>
                  <th><input aria-label="全选" type="checkbox" /></th><th>订单号</th><th>设计款号</th><th>款名</th><th>客户</th><th>类型</th><th>下单总数</th><th>交货日期</th><th>当前节点</th><th>进度</th><th>完成期限</th><th>状态</th><th>操作</th>
                </tr></thead>
                <tbody>
                  {orders.map((order, index) => {
                    const progress = progressFor(order, index);
                    return <tr key={order.orderNo} className={order.orderNo === selected.orderNo ? "is-selected" : undefined}>
                      <td><input aria-label={`选择${order.orderNo}`} type="checkbox" /></td>
                      <td><div className="production-command-order-cell"><span className="production-command-mini-garment" aria-hidden="true"><i /></span><strong>{order.orderNo}</strong></div></td>
                      <td>{order.styleNo}</td>
                      <td>{order.styleName ?? order.category}</td>
                      <td>{order.customer}</td>
                      <td>{order.orderType ?? "大货"}</td>
                      <td>{order.quantity}</td>
                      <td>{order.deliveryDate}</td>
                      <td><span className="production-command-stage-mark" aria-hidden="true" />{order.currentStage}</td>
                      <td><div className={`production-command-progress production-command-progress--${order.nodeRisk}`}><i style={{ width: `${progress}%` }} /><span>{progress}%</span></div></td>
                      <td>{order.nodeDeadline}</td>
                      <td><RiskBadge level={order.nodeRisk} /></td>
                      <td><button className="production-command-row-menu" type="button">•••</button></td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="production-command-detail-grid">
            <article className="production-command-card production-command-detail">
              <div className="production-command-detail-heading">
                <div className="production-command-thumbnail" aria-label="款图占位"><span className="production-command-garment-illustration" aria-hidden="true" /></div>
                <div className="production-command-detail-title">
                  <div className="production-command-title-row">
                    <h2>{selected.styleNo}</h2>
                    <span className="production-command-type-tag">{selected.orderType ?? "大货订单"}</span>
                    <span className="production-command-running-tag">生产中</span>
                  </div>
                  <div className="production-command-detail-facts-grid">
                    <span>客户：<strong>{selected.customer}</strong></span>
                    <span>下单总数：<strong>{selected.quantity}</strong></span>
                    <span>款式类型：<strong>{selected.category}</strong></span>
                    <span>款名：<strong>{selected.styleName ?? selected.category}</strong></span>
                    <span>交货日期：<strong>{selected.deliveryDate}</strong></span>
                    <span>面料类型：<strong>针织</strong></span>
                    <span>设计款号：<strong>{selected.styleNo}</strong></span>
                    <span>跟单员：<strong>{selected.merchandiser}</strong></span>
                    <span>加工工序：<strong>裁剪/车缝/尾部</strong></span>
                  </div>
                </div>
                <div className="production-command-detail-actions">
                  <button type="button">查看单据⌄</button><button type="button">编辑</button><button type="button">更多⌄</button>
                </div>
              </div>

              <nav className="production-command-detail-tabs" aria-label="订单详情导航">
                {detailTabs.map((label, index) => <button key={label} className={index === 0 ? "is-active" : undefined} type="button">{label}</button>)}
              </nav>

              <div className="production-command-timeline" aria-label="生产流程">
                {flow.map(([label, state], index) => (
                  <div key={label} className={`production-command-timeline-item is-${state}`}>
                    <span className="production-command-step">{state === "done" ? "✓" : index + 1}</span>
                    <strong>{label}</strong>
                    <small>{state === "done" ? "已完成" : state === "current" ? "进行中" : "待开始"}</small>
                  </div>
                ))}
              </div>

              <div className="production-command-current-node">
                <div className="production-command-current-node-title"><strong>当前节点详情：{selected.currentStage}</strong><span>节点风险与整单交付风险分别判断</span></div>
                <div className="production-command-current-node-body">
                  <dl>
                    <div><dt>负责人</dt><dd>{selected.merchandiser}</dd></div>
                    <div><dt>进入时间</dt><dd>{selected.nodeEnteredAt}</dd></div>
                    <div><dt>标准时限</dt><dd>{selected.nodeLimit}</dd></div>
                    <div><dt>完成期限</dt><dd>{selected.nodeDeadline}</dd></div>
                    <div><dt>剩余时间</dt><dd><RiskBadge level={selected.nodeRisk}>{selected.nodeRemaining}</RiskBadge></dd></div>
                  </dl>
                  <div className="production-command-current-node-copy">
                    <p><strong>任务说明：</strong>{selected.reason}</p>
                    <p><strong>关联文件：</strong>生产工艺单.pdf</p>
                    <p><strong>上游完成：</strong>纸样 & 唛架</p>
                    <small>未进入的后续节点不提前倒计时。</small>
                  </div>
                  <div className="production-command-current-node-actions"><button className="is-primary" type="button">完成节点</button><button type="button">异常处理</button></div>
                </div>
              </div>
            </article>

            <aside className="production-command-detail-aside">
              <section className="production-command-card production-command-progress-card">
                <h2>订单进度总览</h2>
                <div className="production-command-progress-overview">
                  <div className="production-command-progress-ring" style={progressStyle}><strong>{selectedProgress}%</strong><small>整体进度</small></div>
                  <ul><li><i className="is-done" />已完成 <strong>6</strong></li><li><i className="is-current" />进行中 <strong>1</strong></li><li><i />待开始 <strong>4</strong></li></ul>
                </div>
              </section>

              <section className="production-command-card production-command-risk-list">
                <div className="production-command-aside-heading"><h2>风险提示</h2><button type="button">查看全部 ›</button></div>
                <ul>
                  {orders.slice(0, 4).map(order => <li key={order.orderNo}><i className={`risk-dot risk-dot--${order.nodeRisk}`} /><span><strong>{order.currentStage}</strong><small>{order.nodeRemaining}</small></span></li>)}
                </ul>
                <div className="production-command-overall-risk"><span>整单交付风险</span><RiskBadge level={selected.overallRisk}>{selected.overallRiskText}</RiskBadge></div>
              </section>

              <section className="production-command-card production-command-people-card">
                <div className="production-command-aside-heading"><h2>相关人员</h2><button type="button">更多 ›</button></div>
                <div className="production-command-people">
                  <span><b>设</b><small>设计师<br /><strong>{selected.designer}</strong></small></span>
                  <span><b>跟</b><small>跟单员<br /><strong>{selected.merchandiser}</strong></small></span>
                  <span><b>技</b><small>技术部<br /><strong>李柘恒</strong></small></span>
                </div>
              </section>
            </aside>
          </section>
        </main>
      </section>
    </div>
  );
}

// The production surface uses the approved layout with source-backed values and real actions.
// Preview-only examples above never enter this component's data path.
type LiveProps={data:CockpitResult|null;error:string;stage:CockpitStage;workload:string;search:string;page:number;selectedId:string;onSelect:(id:string)=>void;onStage:(stage:CockpitStage)=>void;onWorkload:(value:string)=>void;onSearch:(value:string)=>void;onPage:(page:number)=>void;actions:ReactNode};
const liveUrls=createWebUrls(import.meta.env.BASE_URL);
const liveDate=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'待确认';
const originalTask=(task:DigitalTask)=>`${liveUrls.pageUrl('ui/digital-production')}?task=${task.taskId}`;
const originalOrder=(row:CockpitRow)=>row.orderId?`${liveUrls.pageUrl('ui/digital-production')}?instruction=${row.orderId}`:row.sourceId?`${liveUrls.pageUrl('ui/digital-production')}?development=${row.sourceId}`:liveUrls.pageUrl('ui/digital-production');
const activeTasks=(row:CockpitRow)=>row.tasks.filter(task=>task.routeVersion===Math.max(...row.tasks.map(item=>item.routeVersion)));
const currentTask=(row:CockpitRow)=>activeTasks(row).find(task=>task.state==='ready'||task.state==='blocked')??activeTasks(row).find(task=>task.state==='pending')??activeTasks(row)[0];
function liveRisk(task:DigitalTask|undefined,now:Date):CommandRisk{
 if(!task||task.state==='pending'||!task.enteredAt)return 'unknown';
 if(task.state==='blocked')return 'high';
 const timing=digitalTaskTiming({...task,terminal:task.state==='completed'},now);
 return timing.state==='overdue'||timing.state==='completed_overdue'?'overdue':timing.state==='attention'?'attention':timing.state==='unknown'||timing.state==='unlimited'?'unknown':'normal';
}
function LiveStyleImage({row,small=false}:{row:CockpitRow;small?:boolean}){
 const [failed,setFailed]=useState(false);
 const src=row.sourceId&&row.styleImageId?liveUrls.apiUrl(`digital-production/sources/${row.sourceId}/development/attachments/${row.styleImageId}`):null;
 return <span className={small?'digital-style-image is-small':'production-command-thumbnail digital-style-image'}>{src&&!failed?<img src={src} alt={`${row.styleNo} 款图`} onError={()=>setFailed(true)}/>:<span>{small?'—':src?'款图暂不可用':'未提供款图'}</span>}</span>;
}
function LiveProductionProgress({row}:{row:CockpitRow}){
 if(!row.progress)return <span className="digital-unknown">路线待确认</span>;
 const percent=Math.round(row.progress.completed/row.progress.applicable*100);
 return <div className="digital-progress"><progress max={row.progress.applicable} value={row.progress.completed}/><span>{percent}% · {row.progress.completed}/{row.progress.applicable} 项</span></div>;
}
function LiveTimeProgress({task,now}:{task:DigitalTask|undefined;now:Date}){
 if(!task)return <span className="digital-unknown">时间待确认</span>;
 const timing=taskTimeProgress(task,now);
 return <div className="digital-progress is-time">{timing.percent!==null&&<progress max={100} value={Math.min(100,timing.percent)}/>}<span>{timing.label}{timing.percent!==null?` · ${timing.percent}%`:''}</span></div>;
}
export function ProductionCommandCenterLiveView(props:LiveProps){
 const {data,stage,workload,search,page,onStage,onWorkload,onSearch,onPage,onSelect}=props;
 const [tab,setTab]=useState('生产进度'),[taskId,setTaskId]=useState('');
 const selected=data?.items.find(row=>row.id===props.selectedId)??data?.items[0];
 const nodes=selected?activeTasks(selected):[];
 const task=nodes.find(node=>node.taskId===taskId)??(selected?currentTask(selected):undefined);
 const now=new Date(),summary=data?.summary;
 const choose=(id:string)=>{onSelect(id);setTaskId('');};
 const risks=selected?.tasks.filter(node=>!['completed','cancelled'].includes(node.state)&&(node.blockedReason||['overdue','attention','unknown'].includes(liveRisk(node,now))))??[];
 return <div className="production-command-main" data-digital-template="live">
  <section className="production-command-overview-row">
   <PageHeader className="production-command-welcome" title="生产管理座舱" description={now.toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'long',day:'numeric',weekday:'long'})} />
   <div className="production-command-summary" aria-label="当前授权筛选范围摘要">
    {[['当前范围',data?.total,'授权订单 / 来源'],['办理中',summary?.active,'有未完成节点'],['即将到期',summary?.dueSoon,'按节点预警阈值'],['已超时',summary?.overdue,'未完成且期限已过'],['受阻订单',summary?.blocked,'需核对原单原因']].map(([label,value,note])=><KpiCard key={label} label={label} value={value??'—'} detail={note} />)}
   </div>
   <aside className="production-command-today-alerts"><h2>▲ 今日待处理</h2><ul><li><span>当前范围超时</span><strong>{summary?.overdue??'—'}</strong></li><li><span>临期（按节点阈值）</span><strong>{summary?.dueSoon??'—'}</strong></li><li><span>阻断待核对</span><strong>{summary?.blocked??'—'}</strong></li><li><span>进入时间待确认</span><strong>{summary?.unknown??'—'}</strong></li></ul></aside>
  </section>
  {props.error&&<p role="alert">{props.error}</p>}
  <section className="production-command-card production-command-orders-card">
   <div className="production-command-order-tabs" aria-label="生产阶段">{([['development','开发打样'],['bulk','大货生产']] as const).map(([value,label])=><button type="button" key={value} aria-pressed={stage===value} className={stage===value?'is-active':undefined} onClick={()=>onStage(value)}>{label}{stage===value&&data?`（${data.total}）`:''}</button>)}</div>
   <FilterBar as="div" className="production-command-toolbar digital-cockpit-toolbar"><label><span>款号 / 客户 / PO</span><input aria-label="款号 / 客户 / PO" placeholder="搜索款号、客户或 PO" value={search} onChange={e=>onSearch(e.target.value)}/></label><label><span>主管调度</span><select aria-label="主管调度" value={workload} onChange={e=>onWorkload(e.target.value)}><option value="all">全部状态</option><option value="unassigned">待派任务</option><option value="blocked">缺料 / 阻断</option><option value="urgent">优先处理</option></select></label><div className="digital-cockpit-tools">{props.actions}<a className="production-command-new-order" href={liveUrls.pageUrl('ui/digital-production')}>原单办理 / 调度</a></div></FilterBar>
   <div className="production-command-table-wrap"><BusinessTable className="production-command-table"><thead><tr><th>母单 / 开发来源</th><th>款图 / 设计款号</th><th>客户</th><th>品类</th><th>类型</th><th>下单总数</th><th>交货日期</th><th>当前节点</th><th>生产进度</th><th>节点时间进度</th><th>完成期限</th><th>状态</th><th>操作</th></tr></thead><tbody>{data?.items.map(row=>{const current=currentTask(row);return <tr key={row.id} className={selected?.id===row.id?'is-selected':undefined}><td><span className="digital-order-id" title={row.id}>{row.id}</span><small>{row.orderId?'母单':'开发来源'}</small></td><td><div className="production-command-order-cell"><LiveStyleImage key={row.styleImageId??row.id} row={row} small/><button className="digital-select-order" onClick={()=>choose(row.id)} aria-pressed={selected?.id===row.id}>{row.styleNo}</button></div></td><td>{row.customer}</td><td>{row.category}</td><td>{stage==='development'?'开发':'大货'}</td><td>{row.lines.length?`${row.lines.reduce((n,line)=>n+line.quantity,0)} 件`:'未下单 / 无可见数量'}</td><td>{row.deliveryDate??'待确认'}</td><td><span className="production-command-stage-mark" aria-hidden="true"/>{current?.label??'路线待发布'}{current?.priority==='urgent'&&<small>优先处理</small>}</td><td><LiveProductionProgress row={row}/></td><td><LiveTimeProgress task={current} now={now}/></td><td>{current?.dueAt?liveDate(current.dueAt):current?.slaHours===null?'无 SLA':'待确认'}</td><td><RiskBadge level={liveRisk(current,now)}>{current?.state==='completed'?'已完成':current?.state==='cancelled'?'已取消':undefined}</RiskBadge></td><td><button onClick={()=>choose(row.id)}>详情</button>{current&&<a href={originalTask(current)}>原办理</a>}</td></tr>;})}</tbody></BusinessTable></div>
   {!data&&!props.error&&<p role="status">正在读取真实授权订单…</p>}{data&&!data.items.length&&<p className="digital-empty">当前授权筛选范围暂无订单或开发来源</p>}
   <Pagination className="digital-cockpit-pagination" page={page} pageSize={15} total={data?.total??null} onPage={onPage} />
  </section>
  {selected&&<section className="production-command-detail-grid">
   <article className="production-command-card production-command-detail">
    <div className="production-command-detail-heading"><LiveStyleImage key={selected.styleImageId??selected.id} row={selected}/><div className="production-command-detail-title"><div className="production-command-title-row"><h2>{selected.styleNo}</h2><span className="production-command-type-tag">{stage==='development'?'开发来源':'大货订单'}</span></div><div className="production-command-detail-facts-grid"><span>客户：<strong>{selected.customer}</strong></span><span>下单总数：<strong>{selected.lines.length?`${selected.lines.reduce((n,line)=>n+line.quantity,0)} 件`:'无可见数量'}</strong></span><span>品类：<strong>{selected.category}</strong></span><span>交货日期：<strong>{selected.deliveryDate??'待确认'}</strong></span><span>设计师：<strong>{selected.designer}</strong></span><span>跟单员：<strong>{selected.merchandiser??'待派'}</strong></span></div><p className="digital-identity-facts">母单：{selected.orderId??'尚未下单'}<br/>开发来源：{selected.sourceId??'尚未提交'}</p></div><div className="production-command-detail-actions"><a href={originalOrder(selected)}>查看原单</a></div></div>
    <nav className="production-command-detail-tabs" aria-label="订单详情导航">{['生产进度','单据与PO','节点历史'].map(label=><button key={label} className={tab===label?'is-active':undefined} aria-pressed={tab===label} onClick={()=>setTab(label)}>{label}</button>)}</nav>
    {tab==='生产进度'&&<><div className="production-command-timeline" aria-label="当前轮次生产流程">{(selected.flow?.length?selected.flow:nodes.map(node=>({key:node.taskId,label:node.label,state:node.state,taskId:node.taskId}))).map((node,index)=><button key={node.key} disabled={!node.taskId} onClick={()=>node.taskId&&setTaskId(node.taskId)} className={`production-command-timeline-item is-${node.state==='completed'?'done':['ready','blocked'].includes(node.state)?'current':'future'}${task?.taskId===node.taskId?' is-selected':''}`} aria-pressed={task?.taskId===node.taskId}><span className="production-command-step">{node.state==='completed'?'✓':index+1}</span><strong>{node.label}</strong><small>{{uncreated:'未生成，未计时',unavailable:'未生成或无查看权限',pending:'前置待齐',ready:'可办理',blocked:'已阻断',completed:'已完成',cancelled:'已取消'}[node.state]}</small></button>)}{!nodes.length&&!selected.flow?.length&&<p>路线尚未发布，暂无可展示节点。</p>}</div>{task&&<div className="production-command-current-node"><div className="production-command-current-node-title"><strong>当前节点详情：{task.label}</strong><span>第 {task.routeVersion} 轮 · 策略 v{task.policyVersion}</span></div><div className="production-command-current-node-body"><dl><div><dt>负责人</dt><dd>{task.assigneeName??'待派'}</dd></div><div><dt>进入时间</dt><dd>{liveDate(task.enteredAt)}</dd></div><div><dt>标准时限</dt><dd>{task.slaHours===null?'无 SLA':`${task.slaHours} 小时`}</dd></div><div><dt>完成期限</dt><dd>{task.slaHours===null?'无 SLA':liveDate(task.dueAt)}</dd></div><div><dt>时间进度</dt><dd><LiveTimeProgress task={task} now={now}/></dd></div></dl><div className="production-command-current-node-copy"><p><strong>节点说明：</strong>{task.blockedReason??(task.state==='pending'?'前置条件未齐，不提前计时。':task.state==='completed'?'已完成，期限与历史记录冻结。':'在原办理页核对前置、资料和业务事实。')}</p><p>优先级：{task.priority==='urgent'?'优先处理':'普通'}</p><small>办理周期不等于净工时。历史仅查看原记录。</small></div><div className="production-command-current-node-actions"><a className="is-primary" href={originalTask(task)}>{['completed','cancelled'].includes(task.state)?'查看历史记录':'进入原办理 / 调度'}</a></div></div></div>}</>}
    {tab==='单据与PO'&&<div className="digital-detail-section"><h3>原始 PO 与款色</h3>{selected.lines.length?selected.lines.map(line=><p key={line.id}>{line.po??'PO 待补'} · {line.color} · {line.quantity} 件</p>):<p>尚无下单 PO 或当前账号无可见 PO。</p>}<a href={originalOrder(selected)}>原单资料、附件与版本</a></div>}
    {tab==='节点历史'&&<div className="digital-detail-section">{selected.tasks.length?selected.tasks.map(node=><p key={node.taskId}><a href={originalTask(node)}>{node.label} · 第 {node.routeVersion} 轮</a> · {node.assigneeName??'待派'} · {taskTimeProgress(node,now).label}</p>):<p>暂无节点历史</p>}<small>历史只读，具体权限仍由原业务页核验。</small></div>}
   </article>
   <aside className="production-command-detail-aside"><section className="production-command-card production-command-progress-card"><h2>订单进度总览</h2><div className="production-command-progress-overview"><div className="production-command-progress-ring" style={{'--command-progress':selected.progress?`${Math.round(selected.progress.completed/selected.progress.applicable*100)}%`:'0%'} as CSSProperties}><strong>{selected.progress?`${Math.round(selected.progress.completed/selected.progress.applicable*100)}%`:'未知'}</strong><small>生产进度</small></div><ul><li>已完成 <strong>{selected.progress?.completed??'未知'}</strong></li><li>适用节点 <strong>{selected.progress?.applicable??'待确认'}</strong></li><li>当前轮可见任务 <strong>{nodes.length}</strong></li></ul></div><p>不适用节点不入分母；未发布路线不按 0% 处理。</p></section><section className="production-command-card production-command-risk-list"><div className="production-command-aside-heading"><h2>本单风险提示</h2></div><ul>{risks.length?risks.map(node=><li key={node.taskId}><i className={`risk-dot risk-dot--${liveRisk(node,now)}`}/><span><a href={originalTask(node)}>{node.label}</a><small>{node.blockedReason??taskTimeProgress(node,now).label}</small></span></li>):<li>{selected.tasks.length?'当前可见节点没有已识别的临期或阻断':'路线待发布，风险待确认'}</li>}</ul><div className="production-command-overall-risk"><span>整单交付判断</span><RiskBadge level="unknown">需核对原单</RiskBadge></div></section><section className="production-command-card production-command-people-card"><div className="production-command-aside-heading"><h2>本单相关人员</h2></div><div className="production-command-people"><span><b>设</b><small>设计师<br/><strong>{selected.designer}</strong></small></span><span><b>跟</b><small>跟单员<br/><strong>{selected.merchandiser??'待派'}</strong></small></span>{Array.from(new Map(nodes.filter(node=>node.assigneeId).map(node=>[node.assigneeId,node])).values()).map(node=><span key={node.assigneeId}><b>办</b><small>{node.label}<br/><strong>{node.assigneeName??'姓名待确认'}</strong></small></span>)}</div></section></aside>
  </section>}
 </div>;
}
