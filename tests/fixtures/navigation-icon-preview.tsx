// Synthetic, offline UI fixture. Never imported by App or production routes.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Shell, Header } from "../../apps/web/src/components.js";
import { NavigationIcon, NAVIGATION_ROUTE_ICONS } from "../../apps/web/src/navigation-icons.js";
import { Button, Surface } from "@dx-rework/ui";
import "../../packages/ui/src/tokens.css";
import "../../packages/ui/src/components.css";
import "../../apps/web/src/styles.css";
import "../../apps/web/src/workflow-shell.css";
import "../../apps/web/src/rework-v2-form.css";
import "./navigation-icon-preview.css";

const actorId = "00000000-0000-4000-8000-000000000001";
// Local fixture responses only. Unlisted requests fail closed; no real API traffic.
window.fetch = async input => {
  if (!String(input).endsWith("/todos/mine/indicator")) throw new Error("不在隔离样板请求白名单内");
  return new Response(JSON.stringify({ pendingCount: 7 }), {
  headers: { "content-type": "application/json", "x-dx-rework-actor-id": actorId },
  });
};
const labels: Record<string, string> = {
  "/ui/my-tasks": "我的待办", "/ui/production-dashboard": "实时生产看板", "/ui/production-reporting": "生产数据填报",
  "/ui/orders": "订单回货", "/ui/tasks": "返工单看板", "/ui/reports": "财务报表", "/ui/wages": "工资管理",
  "/ui/sourcing/create": "创建订单", "/ui/sourcing/pending": "待审批订单", "/ui/sourcing/history": "历史订单",
  "/ui/suppliers": "供应商目录", "/ui/suppliers/manage": "资料维护", "/ui/samples": "在管样衣",
  "/ui/samples/pending": "待确认中心", "/ui/samples/disposed": "已处置样衣", "/ui/samples/amounts": "库存金额管理",
  "/ui/employee-access": "人员与权限", "/ui/admin": "系统管理",
};

function Preview() {
  const [route, setRoute] = useState("/ui/my-tasks");
  const [state, setState] = useState("正常");
  const [detail, setDetail] = useState(false);
  const [query, setQuery] = useState("");
  document.body.dataset.previewRoute = route;
  const title = labels[route] ?? "我的待办";
  const original = document.body.dataset.design === "original";
  const choose = (next: string) => { setRoute(next); setDetail(false); };
  return <div onClickCapture={event => {
    const link = (event.target as HTMLElement).closest("a");
    if (!link) return;
    event.preventDefault();
    const next = link.getAttribute("href")?.replace(/^\/rework/, "");
    if (next && labels[next]) choose(next);
  }}>
    <Shell active={title}>
      <Header title={title} subtitle="导航与标题图标样板 · 所有内容均为合成示例" badge={original ? "原样对照" : "图标初稿"} />
      <Surface>
        <div className="section-title"><h2>选择页面，查看图标效果</h2></div>
        <p>点击左侧菜单或下面的页面名称。手机端可点击底部“更多”。</p>
        <div className="icon-preview-links">
          {Object.keys(NAVIGATION_ROUTE_ICONS).filter(path => document.body.dataset.role !== "worker" || ["/ui/my-tasks", "/ui/orders"].includes(path)).map(path =>
            <Button key={path} onClick={() => choose(path)} aria-pressed={route === path} variant={route === path ? "primary" : "secondary"}>
              {!original && <NavigationIcon route={path} />}{labels[path]}
            </Button>)}
        </div>
      </Surface>
      <Surface>
        <div className="section-title"><h2>长文本与操作状态</h2></div>
        <div className="rework-v2-grid icon-preview-form">
          <label>查找示例<input placeholder="输入款号或供应商" value={query} onChange={e => setQuery(e.target.value)} /></label>
          <label>显示状态<select className="rework-v2-control" value={state} onChange={e => setState(e.target.value)}>{["正常", "空结果", "加载失败", "金额无权限"].map(s => <option key={s}>{s}</option>)}</select></label>
        </div>
        {state === "加载失败" ? <p role="alert">示例加载失败，请重试。<Button onClick={() => setState("正常")}>重试</Button></p> : state === "空结果" || (query && !"示例供应商春秋服装加工有限公司多款色针织外套TEST-260907".includes(query)) ? <p role="status">没有符合条件的示例。<Button onClick={() => { setState("正常"); setQuery(""); }}>清空筛选</Button></p> :
          <div className="icon-preview-example">
            <div className="icon-preview-no-image">暂无图片</div>
            <div><strong>示例供应商春秋服装加工有限公司 · 多款色针织外套</strong><p>TEST-260907 · 深蓝 / 灰白 / 黑 · 12,800 件</p><p>{state === "金额无权限" || document.body.dataset.role === "worker" ? "金额按角色权限隐藏" : "示例金额：¥1,280,000.00"}</p></div>
            <Button onClick={() => setDetail(true)}>查看示例</Button>
          </div>}
      </Surface>
      {detail && <Surface><div className="section-title"><h2>{!original && <NavigationIcon route={route} size="title" />}示例详情</h2><Button onClick={() => setDetail(false)}>收起详情</Button></div><p>TEST-260907 · 3 款色 · 合成记录</p><p>用于核验标题、长文本与按钮位置。供应商、样衣和生产页面的正式布局将在对应 PR 单独提供样板。</p><Button disabled>保存（只读示例）</Button></Surface>}
    </Shell>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
