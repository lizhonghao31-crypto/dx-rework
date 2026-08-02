import { useEffect, useState, type ReactNode } from "react";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";
import { createWebUrls } from "../url-contract.js";

export type AuthorizedUser = {
  displayName: string;
  capabilities: readonly string[];
  businessRoles?: readonly string[];
};
type Me = { status: "authorized" | "no_role"; user: AuthorizedUser };
export type PageAccessRequirement = {
  requiredRole?: string | undefined;
  requiredCapability?: string | undefined;
};

export function hasPageAccess(
  user: AuthorizedUser,
  requirement: PageAccessRequirement = {},
): boolean {
  return (
    (!requirement.requiredRole
      || user.businessRoles?.includes(requirement.requiredRole) === true)
    && (!requirement.requiredCapability
      || user.capabilities.includes(requirement.requiredCapability))
  );
}
type ClientConfig = { corpId: string; mobileClientId: string };
type DingTalkWindow = Window & { dd?: { runtime?: { permission?: { requestAuthCode?: (input: { corpId: string; onSuccess: (value: { code: string }) => void; onFail: (error: unknown) => void }) => void } } } };
const { base, pageUrl, apiUrl } = createWebUrls(import.meta.env.BASE_URL);

function StatePage({ tone, title, detail, children }: { tone: "info" | "warning" | "danger"; title: string; detail: string; children?: ReactNode }) {
  return <main className="auth-shell"><Surface className="auth-card"><StatusBadge tone={tone}>公司组织准入</StatusBadge><h1>{title}</h1><p>{detail}</p>{children}</Surface></main>;
}

export function AuthGate({
  children,
  requiredRole,
  requiredCapability,
}: {
  children: ReactNode;
  requiredRole?: string | undefined;
  requiredCapability?: string | undefined;
}) {
  const [state, setState] = useState<"loading" | "denied" | Me>("loading");
  useEffect(() => { void fetch(apiUrl("auth/me"), { credentials: "include" }).then(async (response) => response.ok ? setState(await response.json() as Me) : setState("denied")).catch(() => setState("denied")); }, []);
  if (state === "loading") return <StatePage tone="info" title="正在确认身份" detail="正在通过服务端核验钉钉组织与账号状态，请稍候。" />;
  if (state === "denied") return <LoginPage />;
  if (state.status === "no_role") return <StatePage tone="warning" title="尚未分配业务角色" detail="您的公司组织身份已验证，但暂时不能读取业务数据。请联系管理员分配业务角色。"><Button onClick={() => void fetch(apiUrl("auth/logout"), { method: "POST", credentials: "include" }).then(() => window.location.assign(base))}>退出登录</Button></StatePage>;
  if (!hasPageAccess(state.user, { requiredRole, requiredCapability })) {
    return <StatePage tone="warning" title="无权访问此页面" detail="当前业务角色或权限不包含此页面；如需操作，请联系管理员核对岗位权限。" />;
  }
  return children;
}

export function LoginPage() {
  const [message, setMessage] = useState("请使用钉钉完成公司身份认证。");
  const isContainer = /DingTalk/i.test(navigator.userAgent);
  const start = async () => {
    if (!isContainer) { window.location.assign(pageUrl("auth/qr")); return; }
    setMessage("正在唤起钉钉免密认证…");
    try {
      const response = await fetch(apiUrl("auth/client-config"), { credentials: "include" });
      if (!response.ok) throw new Error();
      const config = await response.json() as ClientConfig;
      await loadDingTalkJsApi();
      const requestAuthCode = (window as DingTalkWindow).dd?.runtime?.permission?.requestAuthCode;
      if (!requestAuthCode) throw new Error();
      requestAuthCode({ corpId: config.corpId, onSuccess: ({ code }) => { void submitMobileCode(code, setMessage); }, onFail: () => setMessage("钉钉免密认证失败，请重试；仍无法登录请联系管理员确认应用权限。") });
    } catch { setMessage("无法加载钉钉认证能力，请检查网络后重试，或联系管理员。") }
  };
  useEffect(() => { if (isContainer) void start(); }, []);
  return <StatePage tone="info" title="钉钉安全登录" detail={message}><Button onClick={() => void start()}>{isContainer ? "重新尝试免密登录" : "使用钉钉扫码登录"}</Button></StatePage>;
}

async function submitMobileCode(code: string, setMessage: (message: string) => void): Promise<void> {
  try {
    const response = await fetch(apiUrl("auth/mobile"), { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    if (response.ok) window.location.assign(base); else setMessage("公司组织或账号状态校验未通过，请联系管理员。");
  } catch { setMessage("登录请求未送达，请检查网络后重试。"); }
}

let dingTalkScript: Promise<void> | undefined;
async function loadDingTalkJsApi(): Promise<void> {
  if ((window as DingTalkWindow).dd) return;
  dingTalkScript ??= new Promise<void>((resolve, reject) => { const script = document.createElement("script"); script.src = "https://g.alicdn.com/dingding/dingtalk-jsapi/3.1.0/dingtalk.open.js"; script.async = true; script.onload = () => resolve(); script.onerror = () => { dingTalkScript = undefined; reject(new Error("DingTalk JSAPI failed")); }; document.head.append(script); });
  await dingTalkScript;
}

export function QrLoginPage() {
  const [message, setMessage] = useState("正在生成一次性扫码请求…");
  useEffect(() => { void fetch(apiUrl("auth/qr/start"), { method: "POST", credentials: "include" }).then(async (response) => { if (!response.ok) throw new Error(); const body = await response.json() as { authorizationUrl: string }; window.location.assign(body.authorizationUrl); }).catch(() => setMessage("扫码请求生成失败，请刷新重试或联系管理员。")); }, []);
  return <StatePage tone="info" title="钉钉扫码登录" detail={message} />;
}

export function DeniedPage() { return <StatePage tone="danger" title="无法进入系统" detail="组织、在职或账号启用状态未通过服务端校验。如有疑问，请联系管理员。"><Button onClick={() => window.location.assign(base)}>返回登录</Button></StatePage>; }
