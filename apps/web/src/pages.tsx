import { useEffect, useState } from "react";
import { VersionResponseSchema, type VersionResponse } from "@dx-rework/contracts";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { Header, Kpis, Queue, Shell, TaskCard } from "./components.js";
import { members, tasks } from "./fixtures.js";
import { ResponsibilityDeterminationPanel } from "./responsibility-determination-panel.js";

type LoadState = { kind: "loading" } | { kind: "ready"; version: VersionResponse } | { kind: "unavailable" };

export function Dashboard({ supervisor = false }: { supervisor?: boolean }) {
  return <Shell active="总览"><Header title={supervisor ? "李同生 · 现场返工工作台" : "管理层共享座舱"} subtitle={supervisor ? "配置工序与单价、动态分派成员、整单审核、工资初核" : "李总、伍总、张文豪查看同一事实；本厂承担最终审批仅李总 / 伍总"} badge={supervisor ? "N01–N10-A 现场节点" : "N00–N09 实时同步"} action={supervisor ? "开始处理下一单" : "导出当前视图"} /><Kpis supervisor={supervisor} /><div className="dashboard-grid"><div className="dashboard-main"><Queue supervisor={supervisor} />{!supervisor && <Surface className="lifecycle"><div className="section-title"><h2>最近返工与双生命周期</h2><Button>查看明细</Button></div><div className="lifecycle-record"><b>RW-2026-0801-012 · PD20529725 · 集体 7 人 · ¥512.25</b><small>工资：已审核待月结 | 外部扣款：签收跟进中 | 操作链：18 条</small></div><StatusBadge tone="info">外部扣款未完成，不阻塞返工业务完结</StatusBadge></Surface>}</div><Surface className="decisions"><h2>{supervisor ? "快捷操作与现场异常" : "待决策与异常"}</h2><p>{supervisor ? "李同生仅展示现场动作，不混入老板终审" : "事实对三人完全共享；操作按钮按登录身份开放"}</p>{!supervisor && <StatusBadge tone="warning">张文豪无本厂承担最终审批权</StatusBadge>}{tasks.slice(0, 3).map((task) => <TaskCard key={task.id} task={task} />)}{!supervisor && <Button variant="primary" className="all-decisions">查看全部待决</Button>}</Surface></div></Shell>;
}

export function Tasks() {
  return <Shell active="返工任务"><Header title="返工任务列表" subtitle="统一查询返工单、当前节点、责任链、计件与扣款状态" badge="28 条 · N01–N10-B" action="发起返工" /><Surface className="filters"><InsetField label="关键词" aria-label="关键词" placeholder="单号 / 款号 / 发起人 / 责任人" /><Button variant="primary">全部 28</Button><Button>待处理 12</Button><Button>进行中 8</Button><Button>待责任 5</Button></Surface><h2>任务结果（28）</h2><div className="task-grid">{tasks.map((task) => <TaskCard key={task.id} task={task} />)}</div></Shell>;
}

export function Detail() {
  return <Shell active="责任处理"><Header title="RW-2026-0801-012 · PD20529725" subtitle="尾部返工 · 281 件 · 当前节点 N07 责任判定" badge="生产管理处理中" action="返回任务列表" /><div className="dashboard-grid"><Surface><h2>节点时间线与返工摘要</h2><div className="queue">{["N01 品控发起 · 08:42", "N02 李同生配置工序 · 09:18", "N03 IE 审核 · 09:46", "N04 动态分派 · 成员快照 V1", "N05 集体上数完成 · 281 件", "N06 李同生整单审核 · 已通过"].map((row) => <div key={row}><span>{row}</span><StatusBadge tone="info">已完成</StatusBadge></div>)}</div></Surface><ResponsibilityDeterminationPanel /></div></Shell>;
}

export function MobileForm({ piecework = false }: { piecework?: boolean }) {
  const share = 154.55 / members.length;
  return <main className="mobile-page"><div className="mobile-hero"><div className="mobile-title"><h1>{piecework ? "集体计件上数" : "发起返工"}</h1>{piecework && <StatusBadge tone="info">本次 {members.length} 人</StatusBadge>}</div><p>{piecework ? "RW-2026-0801-018 · 返查工序" : "品控现场录入 · 提交后通知李同生"}</p><StatusBadge tone="success">{piecework ? "N05 上数中 · 自动防重" : "组织内已认证 · 可保存草稿"}</StatusBadge></div><Surface><div className="section-title"><h2>{piecework ? "任务信息" : "返工基本信息"}</h2>{piecework && <StatusBadge tone="info">成员快照 V1</StatusBadge>}</div><p>款号：{piecework ? "PD20611308 · 计划：281 件" : "PD20529725"}<br />{piecework ? `本条快照：${members.join("、")}` : "订单跟单：陈晓琳 · 加工厂：本厂"}</p>{piecework && <p className="hint">人员变化须新建成员版本；历史上数不反算，本条始终按快照 V1 分摊。</p>}</Surface><Surface><h2>{piecework ? "本次上数" : "返工数量"}</h2><InsetField label="" aria-label={piecework ? "本次上数" : "返工数量"} value="281" readOnly suffix="件" /><p>{piecework ? "单价 ¥0.55 / 件  组总额 ¥154.55" : "类型：尾查 / 拆包 / 重新包装"}</p></Surface><Surface className="share-preview"><h2>{piecework ? "平均分摊预览" : "QC 证据"}</h2>{piecework ? <><StatusBadge tone="success">快照 V1 · {members.length} 人</StatusBadge><p>¥154.55 ÷ 快照 V1 的 {members.length} 人 = ¥{share.toFixed(6)}…</p><InsetField label="你的预估分摊" value={share.toFixed(2)} readOnly suffix="元（只读）" /><small>提交后按成员快照 V1 分摊；个人明细合计必须严格等于组总额 ¥154.55</small></> : <><p>拆包前照片 · 疵点近照 · 整单标签</p><InsetField label="QC 附件" value="3" readOnly suffix="份" /></>}</Surface><div className="mobile-actions"><Button>保存草稿</Button><Button variant="primary">{piecework ? "提交集体上数" : "预览提交并通知"}</Button></div></main>;
}

export function Foundation() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/version", { signal: controller.signal, headers: { accept: "application/json" } }).then(async (response) => {
      if (!response.ok) throw new Error("Version endpoint unavailable");
      return VersionResponseSchema.parse(await response.json());
    }).then((version) => setState({ kind: "ready", version })).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) setState({ kind: "unavailable" });
    });
    return () => controller.abort();
  }, []);
  return <main className="foundation-shell"><section className="foundation-card" aria-labelledby="foundation-title"><p className="eyebrow">PR-01 · TECHNICAL FOUNDATION</p><h1 id="foundation-title">内部计件返工系统</h1><p className="summary">当前页面仅用于验证独立前端、API 与版本追踪链路。经业务验收的混合工业风页面将在 PR-01A 按 Figma Golden Source 落地。</p><dl className="status-grid"><div><dt>前端</dt><dd>独立运行</dd></div><div><dt>API</dt><dd>{state.kind === "loading" ? "检查中" : state.kind === "ready" ? "可访问" : "未连接"}</dd></div><div><dt>Git SHA</dt><dd>{state.kind === "ready" ? state.version.gitSha.slice(0, 12) : "—"}</dd></div><div><dt>Schema</dt><dd>{state.kind === "ready" ? (state.version.schemaVersion ?? "未迁移") : "—"}</dd></div></dl><p className="boundary-note">不连接 ERP · 不启用钉钉 · 不写入生产数据</p></section></main>;
}
