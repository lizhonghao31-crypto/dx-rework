import { StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import type { AuthorizedUser } from "./auth.js";
import "./frontline-landing-page.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

type LandingMe = Readonly<{
  status: "authorized" | "no_role";
  user: AuthorizedUser;
}>;
type Entry = Readonly<{ label: string; description: string; href: string }>;
type State =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; user: AuthorizedUser }>
  | Readonly<{ kind: "error"; message: string }>;

const has = (user: AuthorizedUser, capability: string): boolean =>
  user.capabilities.includes(capability);
const hasRole = (user: AuthorizedUser, role: string): boolean =>
  user.businessRoles?.includes(role) === true;

export function frontlineEntries(user: AuthorizedUser): readonly Entry[] {
  const entries: Entry[] = [];

  if (hasRole(user, "warehouse_receiver") && has(user, "receiving:create")) {
    entries.push({ label: "仓库收货", description: "登记返工订单的到货信息", href: pageUrl("ui/receiving") });
  }
  if (hasRole(user, "worker") && has(user, "work:report")) {
    entries.push({ label: "本人返工任务", description: "查看本人任务并登记完成数量", href: pageUrl("ui/work-reporting?queue=in_progress") });
  }
  if (hasRole(user, "tail_inspector") && has(user, "tail_inspection:report")) {
    entries.push({ label: "本人尾查任务", description: "进入统一任务工作台登记本人尾查结果", href: pageUrl("ui/work-reporting?queue=in_progress") });
  }
  if (has(user, "todo:view")) {
    entries.push({ label: "我的待办", description: "处理分配给本人的待办事项", href: pageUrl("ui/my-tasks") });
  }

  return entries;
}

export function FrontlineLandingPage() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let mounted = true;
    void fetch(apiUrl("auth/me"), { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("入口加载失败，请刷新页面重试。");
        const body = await response.json() as LandingMe;
        if (body.status !== "authorized") throw new Error("当前账号尚未分配业务角色。");
        if (mounted) setState({ kind: "ready", user: body.user });
      })
      .catch((error: unknown) => {
        if (mounted) setState({ kind: "error", message: error instanceof Error ? error.message : "入口加载失败，请刷新页面重试。" });
      });
    return () => { mounted = false; };
  }, []);

  const entries = state.kind === "ready" ? frontlineEntries(state.user) : [];
  return (
    <main className="frontline-landing">
      <Surface className="frontline-landing__surface">
        <div className="frontline-landing__heading">
          <StatusBadge tone="info">一线工作台</StatusBadge>
          <h1>{state.kind === "ready" ? `${state.user.displayName}，请选择工作入口` : "正在加载工作入口"}</h1>
          <p>{state.kind === "error" ? state.message : "只显示与你当前岗位和权限匹配的入口。"}</p>
        </div>
        {state.kind === "ready" ? <nav className="frontline-landing__entries" aria-label="一线工作入口">
          {entries.map((entry) => <a key={entry.label} href={entry.href}>
            <span><b>{entry.label}</b><small>{entry.description}</small></span>
            <strong aria-hidden="true">进入</strong>
          </a>)}
        </nav> : null}
      </Surface>
    </main>
  );
}
