import type { ReactNode } from "react";
import { Button, KpiInstrument, NavigationItem, StatusBadge, Surface } from "@dx-rework/ui";
import type { Task } from "./types.js";

export function Shell({ active, children }: { active: string; children: ReactNode }) {
  const navigation = [["总", "总览", "/ui/management"], ["工", "返工任务", "/ui/tasks"], ["责", "责任处理", "/ui/tasks/RW-2026-0728-003"], ["计", "集体计件", "/ui/piecework/collective"]];
  return <div className="app-shell"><aside><h2>达兴 · 质检返工</h2><small>李总 · 伍总 · 张文豪<br />同一事实视图</small><nav aria-label="主导航">{navigation.map(([icon, name, href]) => <a href={href} key={name}><NavigationItem icon={icon!} active={active === name}>{name}</NavigationItem></a>)}<button className="nav-disabled" type="button" disabled aria-disabled="true"><NavigationItem icon="审">审计日志</NavigationItem></button></nav><div className="org"><StatusBadge tone="success">组织内已认证</StatusBadge><b>共享事实 · 全量可见</b><small>操作按钮按登录身份开放；<br />所有接管与审批写入日志</small></div></aside><main>{children}</main></div>;
}

export function Header({ title, subtitle, badge, action }: { title: string; subtitle: string; badge: string; action: string }) {
  return <header><div><h1>{title}</h1><p>{subtitle}</p></div><div className="header-actions"><StatusBadge tone="info">{badge}</StatusBadge><Button>{action}</Button></div></header>;
}

export function Kpis({ supervisor = false }: { supervisor?: boolean }) {
  const data: [string, number, string][] = supervisor ? [["待配置工序 / 单价", 4, "最早进入 09:18"], ["待分派 / 改成员", 3, "2 条待生成新快照"], ["待整单审核", 5, "含 1 条驳回重提"], ["现场异常", 2, "1 单等待补料"]] : [["待处理项", 12, "其中 3 单临近时限"], ["进行中", 8, "覆盖 4 个工序"], ["已超时", 3, "最长超时 1.6 天"], ["待责任确认", 5, "2 单待老板终审"]];
  return <div className="kpis">{data.map(([label, value, detail], index) => <KpiInstrument key={label} label={label} value={value} detail={detail} tone={index === 2 ? "warning" : "info"} />)}</div>;
}

export function Queue({ supervisor = false }: { supervisor?: boolean }) {
  const rows = supervisor ? ["N02　待配置工序 / 单价", "N04　待分派成员", "N04-V2　新成员快照待确认", "N06　待整单审核", "N10-A　工资初核", "异常　现场异常 / 等待补料"] : ["N01　待主管配置", "N03　待 IE 复核", "N05　返工上数中", "N07　待责任确认", "N08-A　本厂承担审批", "N08-B　外部签收 / 扣款跟进"];
  return <Surface><div className="section-title"><div><h2>{supervisor ? "今日行动队列" : "全流程节点监控"}</h2><p>按 N00–N09 统一看板，工资核对与外部扣款独立跟踪</p></div>{!supervisor && <StatusBadge tone="info">更新 14:32</StatusBadge>}</div><div className="queue">{rows.map((row, index) => <div key={row}><span>{row}</span><StatusBadge tone={index === 3 || index === 4 ? "warning" : "info"}>{index + 2} 单</StatusBadge></div>)}</div></Surface>;
}

export function TaskCard({ task }: { task: Task }) {
  const state = task.tone === "danger" ? "已超时" : task.tone === "warning" ? "临近时限" : "待跟进";
  return <article className={`task task--${task.tone}`}><b>{task.id}</b><StatusBadge tone={task.tone}>{state}</StatusBadge><h3>{task.title}</h3><small>{task.meta}</small></article>;
}
