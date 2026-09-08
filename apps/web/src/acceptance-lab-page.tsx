import { useCallback, useEffect, useMemo, useState } from "react";

import { Button, StatusBadge, Surface } from "@dx-rework/ui";

import { createWebUrls } from "../url-contract.js";
import type { AuthorizedUser } from "./auth.js";
import { platformLandingTarget } from "./platform-modules.js";
import "./acceptance-lab-page.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

type AcceptanceIdentity = Readonly<{
  alias: string;
  userId: string;
  displayName: string;
  active: boolean;
  employed: boolean;
  roleCodes: readonly string[];
  capabilities: readonly string[];
}>;

type LabState = "loading" | "locked" | "ready" | "unavailable";

const roleLabels: Readonly<Record<string, string>> = {
  owner_group: "老板",
  production_management: "生产管理",
  ie_reviewer: "IE",
  tail_supervisor: "尾部主管",
  quality_control: "质检",
  warehouse_receiver: "仓管",
  worker: "工人",
  order_merchandiser: "订单跟单",
  finance_read: "财务全局查看",
  finance_director: "财务总监",
  factory_payables: "加工厂应付会计",
  system_admin: "系统管理员",
  production_reporter: "驻厂生产填报",
  sample_designer: "样衣设计师",
  sample_administrative: "样衣管理员",
  sample_finance: "样衣财务",
  sample_approver: "样衣审批人",
};

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T | null }> {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    cache: "no-store",
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  let body: T | null = null;
  try { body = await response.json() as T; } catch { body = null; }
  return { status: response.status, body };
}

export function AcceptanceLabPage() {
  const [state, setState] = useState<LabState>("loading");
  const [code, setCode] = useState("");
  const [identities, setIdentities] = useState<readonly AcceptanceIdentity[]>([]);
  const [currentUser, setCurrentUser] = useState<AuthorizedUser | null>(null);
  const [busyAlias, setBusyAlias] = useState("");
  const [error, setError] = useState("");

  const refreshCurrentUser = useCallback(async () => {
    const response = await jsonRequest<{ user?: AuthorizedUser }>("auth/me");
    setCurrentUser(response.status === 200 && response.body?.user ? response.body.user : null);
  }, []);

  const refreshControl = useCallback(async () => {
    setError("");
    const response = await jsonRequest<{ identities?: readonly AcceptanceIdentity[] }>("acceptance/control/status");
    if (response.status === 404) {
      setState("unavailable");
      setIdentities([]);
      return;
    }
    if (response.status === 401) {
      setState("locked");
      setIdentities([]);
      return;
    }
    if (response.status !== 200 || !response.body?.identities) {
      setState("locked");
      setError("验收控制状态读取失败，请重新取得控制凭证。");
      return;
    }
    setIdentities(response.body.identities);
    setState("ready");
    await refreshCurrentUser();
  }, [refreshCurrentUser]);

  useEffect(() => { void refreshControl(); }, [refreshControl]);

  const begin = async () => {
    if (!code.trim()) return;
    setError("");
    const response = await jsonRequest<{ status?: string; error?: { message?: string } }>("acceptance/control/start", {
      method: "POST",
      body: JSON.stringify({ code: code.trim() }),
    });
    if (response.status !== 200) {
      setError(response.body?.error?.message ?? "验收控制凭证无效或已过期。");
      return;
    }
    setCode("");
    await refreshControl();
  };

  const switchIdentity = async (alias: string) => {
    setBusyAlias(alias); setError("");
    try {
      const response = await jsonRequest<{ error?: { message?: string } }>("acceptance/control/switch", {
        method: "POST",
        body: JSON.stringify({ alias }),
      });
      if (response.status !== 200) {
        setError(response.body?.error?.message ?? "切换验收身份失败。");
        if (response.status === 401) setState("locked");
        return;
      }
      await refreshCurrentUser();
    } finally {
      setBusyAlias("");
    }
  };

  const end = async () => {
    setError("");
    const response = await fetch(apiUrl("acceptance/control/end"), {
      method: "POST", credentials: "include", cache: "no-store",
    });
    if (response.status !== 204) {
      setError("结束验收失败，请刷新后重试。");
      return;
    }
    setCurrentUser(null); setIdentities([]); setState("locked");
  };

  const currentTarget = useMemo(() => currentUser ? platformLandingTarget(currentUser) : null, [currentUser]);

  if (state === "loading") return <main className="acceptance-lab"><Surface><p role="status">正在检查隔离验收中心…</p></Surface></main>;
  if (state === "unavailable") return <main className="acceptance-lab"><Surface><h1>隔离验收中心未启用</h1><p>此入口只在明确启用 Acceptance Lab 的测试环境提供，正式环境不会注册控制接口。</p></Surface></main>;

  if (state === "locked") return <main className="acceptance-lab"><Surface className="acceptance-control-card">
    <StatusBadge tone="info">隔离验收中心</StatusBadge>
    <h1>取得验收控制权限</h1>
    <p>控制权限与被测业务身份相互独立。使用一次性控制凭证后，可自行切换不同测试角色。</p>
    <label>一次性控制凭证<textarea value={code} onChange={event => setCode(event.target.value)} rows={4} autoComplete="off" /></label>
    {error ? <p role="alert">{error}</p> : null}
    <Button onClick={() => void begin()} disabled={!code.trim()}>进入验收中心</Button>
  </Surface></main>;

  return <main className="acceptance-lab">
    <header className="acceptance-lab__header">
      <div><StatusBadge tone="success">Acceptance Lab 已隔离</StatusBadge><h1>角色权限验收中心</h1><p>每次切换都会建立对应合成用户的真实业务 Session，不继承操作者 Root 权限。</p></div>
      <Button variant="secondary" onClick={() => void end()}>结束验收</Button>
    </header>
    {error ? <p role="alert" className="acceptance-lab__error">{error}</p> : null}
    <Surface className="acceptance-current">
      <h2>当前被测身份</h2>
      {currentUser ? <div><strong>{currentUser.displayName}</strong><span>{currentUser.isRoot ? "Root" : currentUser.businessRoles?.map(role => roleLabels[role] ?? role).join(" / ") || "无业务角色"}</span>
        {currentTarget ? <a className="acceptance-open-business" href={pageUrl(currentTarget)} target="_blank" rel="noreferrer">新窗口打开当前身份业务页</a> : null}
      </div> : <p>尚未选择被测身份。</p>}
    </Surface>
    <section className="acceptance-identities" aria-label="标准验收身份">
      {identities.map(identity => <Surface className="acceptance-identity" key={identity.userId}>
        <div><strong>{identity.displayName}</strong><small>{identity.roleCodes.map(role => roleLabels[role] ?? role).join(" / ") || "未分配角色"}</small></div>
        <div className="acceptance-identity__meta"><span>{identity.alias}</span><span>{identity.capabilities.length} 项 capability</span></div>
        <Button onClick={() => void switchIdentity(identity.alias)} disabled={!identity.active || !identity.employed || Boolean(busyAlias)}>{busyAlias === identity.alias ? "切换中…" : "切换到此身份"}</Button>
      </Surface>)}
    </section>
  </main>;
}
