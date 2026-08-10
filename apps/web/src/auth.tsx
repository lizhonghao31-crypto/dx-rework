import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";
import { createWebUrls } from "../url-contract.js";

export type AuthorizedUser = {
  displayName: string;
  capabilities: readonly string[];
  businessRoles?: readonly string[];
  isRoot?: boolean;
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
  if (user.isRoot === true) return true;
  return (
    (!requirement.requiredRole
      || user.businessRoles?.includes(requirement.requiredRole) === true)
    && (!requirement.requiredCapability
      || user.capabilities.includes(requirement.requiredCapability))
  );
}

type ClientConfig = { corpId: string; mobileClientId: string };
type QrFrameConfig = {
  clientId: string;
  redirectUri: string;
  state: string;
  scope: string;
  responseType: string;
  prompt: string;
};
type QrStartResponse = { authorizationUrl: string; frame: QrFrameConfig };
type DingTalkFrameResult = { authCode?: string; code?: string; state?: string };
type DingTalkFrameLogin = (
  container: { id: string; width: number; height: number },
  parameters: {
    redirect_uri: string;
    client_id: string;
    scope: string;
    response_type: string;
    state: string;
    prompt: string;
  },
  onSuccess: (result: DingTalkFrameResult) => void,
  onError: (message: string) => void,
) => void;
type DingTalkWindow = Window & {
  dd?: {
    runtime?: {
      permission?: {
        requestAuthCode?: (input: {
          corpId: string;
          onSuccess: (value: { code: string }) => void;
          onFail: (error: unknown) => void;
        }) => void;
      };
    };
  };
  DTFrameLogin?: DingTalkFrameLogin;
};
type QrRelayMessage = { type: typeof QR_RELAY_MESSAGE; authCode: string; state: string };
type ErrorBody = { error?: { code?: string; message?: string } };

const { base, apiUrl } = createWebUrls(import.meta.env.BASE_URL);
type AuthGateState = "loading" | "denied" | Me;
type VerifiedSession = Exclude<AuthGateState, "loading">;
let verifiedSession: VerifiedSession | undefined;
let sessionVerification: Promise<VerifiedSession> | undefined;

const verifySession = (): Promise<VerifiedSession> => {
  if (verifiedSession) return Promise.resolve(verifiedSession);
  sessionVerification ??= fetch(apiUrl("auth/me"), { credentials: "include" })
    .then(async (response) => response.ok ? await response.json() as Me : "denied")
    .catch(() => "denied")
    .then((state) => {
      verifiedSession = state;
      return state;
    });
  return sessionVerification;
};

const QR_CONTAINER_ID = "dx-rework-dingtalk-qr";
const QR_RELAY_MESSAGE = "dx-rework:dingtalk-qr-code" as const;

let qrStartPromise: Promise<QrStartResponse> | undefined;
async function getQrStart(): Promise<QrStartResponse> {
  qrStartPromise ??= fetch(apiUrl("auth/qr/start"), {
    method: "POST",
    credentials: "include",
  }).then(async (response) => {
    if (!response.ok) throw new Error(`qr start failed: ${response.status}`);
    return response.json() as Promise<QrStartResponse>;
  });
  try {
    return await qrStartPromise;
  } catch (error) {
    qrStartPromise = undefined;
    throw error;
  }
}
function resetQrStart(): void {
  qrStartPromise = undefined;
}

function StatePage({ tone, title, detail, children }: { tone: "info" | "warning" | "danger"; title: string; detail: string; children?: ReactNode }) {
  return <main className="auth-shell"><Surface className="auth-card"><StatusBadge tone={tone}>达兴组织准入</StatusBadge><h1>{title}</h1><p>{detail}</p>{children}</Surface></main>;
}

export function AuthGate({
  children,
  requiredRole,
  requiredCapability,
  requiredAnyOf,
}: {
  children: ReactNode;
  requiredRole?: string | undefined;
  requiredCapability?: string | undefined;
  requiredAnyOf?: readonly PageAccessRequirement[] | undefined;
}) {
  const [state, setState] = useState<AuthGateState>(() => verifiedSession ?? "loading");
  useEffect(() => {
    let mounted = true;
    void verifySession().then((nextState) => {
      if (mounted) setState(nextState);
    });
    return () => {
      mounted = false;
    };
  }, []);
  if (state === "loading") return <StatePage tone="info" title="正在确认身份" detail="正在通过服务端核验钉钉组织与账号状态，请稍候。" />;
  if (state === "denied") return <LoginPage />;
  if (state.status === "no_role") return <StatePage tone="warning" title="尚未分配业务角色" detail="您的达兴组织身份已验证，但暂时不能读取业务数据。请联系管理员分配业务角色。"><Button onClick={() => void fetch(apiUrl("auth/logout"), { method: "POST", credentials: "include" }).then(() => window.location.assign(base))}>退出登录</Button></StatePage>;
  if (
    !hasPageAccess(state.user, { requiredRole, requiredCapability })
    || (
      requiredAnyOf !== undefined
      && !requiredAnyOf.some((requirement) => hasPageAccess(state.user, requirement))
    )
  ) {
    return <StatePage tone="warning" title="无权访问此页面" detail="当前业务角色或权限不包含此页面；如需操作，请联系管理员核对岗位权限。" />;
  }
  return children;
}

export function LoginPage() {
  const [message, setMessage] = useState("正在准备钉钉身份认证…");
  const isContainer = /DingTalk/i.test(navigator.userAgent);
  const start = async () => {
    if (!isContainer) return;
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
  if (!isContainer) return <QrLoginPage />;
  return <StatePage tone="info" title="钉钉安全登录" detail={message}><Button onClick={() => void start()}>重新尝试免密登录</Button></StatePage>;
}

async function submitMobileCode(code: string, setMessage: (message: string) => void): Promise<void> {
  try {
    const response = await fetch(apiUrl("auth/mobile"), { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    if (response.ok) window.location.assign(base); else setMessage(await loginErrorMessage(response));
  } catch { setMessage("登录请求未送达，请检查网络后重试。"); }
}

let dingTalkScript: Promise<void> | undefined;
async function loadDingTalkJsApi(): Promise<void> {
  if ((window as DingTalkWindow).dd) return;
  dingTalkScript ??= new Promise<void>((resolve, reject) => { const script = document.createElement("script"); script.src = "https://g.alicdn.com/dingding/dingtalk-jsapi/3.1.0/dingtalk.open.js"; script.async = true; script.onload = () => resolve(); script.onerror = () => { dingTalkScript = undefined; reject(new Error("DingTalk JSAPI failed")); }; document.head.append(script); });
  await dingTalkScript;
}

let dingTalkQrScript: Promise<void> | undefined;
async function loadDingTalkQrSdk(): Promise<void> {
  if ((window as DingTalkWindow).DTFrameLogin) return;
  dingTalkQrScript ??= new Promise<void>((resolve, reject) => {
    const existing = document.getElementById("dx-rework-dingtalk-qr-sdk");
    if (existing) {
      const waitForSdk = () => {
        if ((window as DingTalkWindow).DTFrameLogin) resolve();
        else window.setTimeout(waitForSdk, 100);
      };
      waitForSdk();
      return;
    }
    const script = document.createElement("script");
    script.id = "dx-rework-dingtalk-qr-sdk";
    script.src = "https://g.alicdn.com/dingding/h5-dingtalk-login/0.21.0/ddlogin.js";
    script.async = true;
    script.onload = () => (window as DingTalkWindow).DTFrameLogin ? resolve() : reject(new Error("DingTalk QR SDK unavailable"));
    script.onerror = () => { dingTalkQrScript = undefined; reject(new Error("DingTalk QR SDK failed")); };
    document.body.appendChild(script);
  });
  await dingTalkQrScript;
}

async function loginErrorMessage(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as ErrorBody | null;
  switch (body?.error?.code) {
    case "NOT_ORGANIZATION_MEMBER": return "该账号不属于达兴企业组织，无法进入系统。";
    case "NOT_EMPLOYED": return "该账号不是达兴在职员工，无法进入系统。";
    case "ACCOUNT_DISABLED": return "该账号已停用，请联系管理员。";
    case "INVALID_QR_STATE": return "二维码已过期或已使用，请重新生成。";
    case "RATE_LIMITED": return "登录请求过于频繁，请稍后重试。";
    default: return body?.error?.message || "公司组织或账号状态校验未通过，请联系管理员。";
  }
}

async function completeQrCode(code: string, state: string, setMessage: (message: string) => void): Promise<boolean> {
  if (!code || !state) {
    setMessage("钉钉未返回完整授权信息，请重新生成二维码。");
    return false;
  }
  setMessage("扫码已确认，正在核验达兴组织与在职状态…");
  try {
    const response = await fetch(apiUrl("auth/qr/complete"), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authCode: code, state }),
    });
    if (!response.ok) {
      setMessage(await loginErrorMessage(response));
      return false;
    }
    const session = await fetch(apiUrl("auth/me"), {
      credentials: "include",
      cache: "no-store",
    });
    if (!session.ok) {
      setMessage("扫码已通过，但登录会话未建立成功。请不要重新扫码，联系管理员检查会话 Cookie。 ");
      return false;
    }
    resetQrStart();
    window.location.replace(base);
    return true;
  } catch {
    setMessage("扫码结果未送达服务端，请检查网络后重新生成二维码。");
    return false;
  }
}

export function QrLoginPage() {
  const [message, setMessage] = useState("正在生成钉钉二维码…");
  const [attempt, setAttempt] = useState(0);
  const [starting, setStarting] = useState(true);
  const completing = useRef(false);
  const challengeBusy = useRef(true);

  useEffect(() => {
    let cancelled = false;
    let expectedState = "";
    let retryTimer: number | undefined;
    completing.current = false;

    const consumeCode = async (code: string, returnedState?: string) => {
      if (cancelled || completing.current) return;
      if (returnedState && returnedState !== expectedState) {
        setMessage("扫码状态校验失败，请点击重新生成二维码后再扫一次。");
        return;
      }
      completing.current = true;
      const succeeded = await completeQrCode(code, expectedState, setMessage);
      if (!succeeded) completing.current = false;
    };

    const relay = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || typeof event.data !== "object" || event.data === null) return;
      const data = event.data as Partial<QrRelayMessage>;
      if (data.type !== QR_RELAY_MESSAGE || typeof data.authCode !== "string" || typeof data.state !== "string") return;
      void consumeCode(data.authCode, data.state);
    };
    window.addEventListener("message", relay);

    const renderDingQr = (body: QrStartResponse) => {
      if (cancelled) return;
      const container = document.getElementById(QR_CONTAINER_ID);
      if (!container) {
        window.requestAnimationFrame(() => renderDingQr(body));
        return;
      }
      const frameLogin = (window as DingTalkWindow).DTFrameLogin;
      if (!frameLogin) {
        retryTimer = window.setTimeout(() => renderDingQr(body), 100);
        return;
      }
      container.innerHTML = "";
      frameLogin(
        { id: QR_CONTAINER_ID, width: 300, height: 300 },
        {
          redirect_uri: encodeURIComponent(body.frame.redirectUri),
          client_id: body.frame.clientId,
          scope: body.frame.scope,
          response_type: body.frame.responseType,
          state: body.frame.state,
          prompt: body.frame.prompt,
        },
        (result) => { void consumeCode(result.authCode ?? result.code ?? "", result.state); },
        () => setMessage("二维码已失效或暂时不可用，请点击重新生成二维码。"),
      );
    };

    const start = async () => {
      setStarting(true);
      challengeBusy.current = true;
      setMessage("正在生成钉钉二维码…");
      try {
        const body = await getQrStart();
        expectedState = body.frame.state;
        await loadDingTalkQrSdk();
        if (cancelled) return;
        setMessage("请使用手机钉钉扫描二维码，并在钉钉中确认登录。二维码过期时再点击下方按钮重新生成。");
        window.requestAnimationFrame(() => renderDingQr(body));
      } catch {
        if (!cancelled) setMessage("二维码生成失败，请点击重新生成；仍失败请联系管理员确认钉钉应用配置。");
      } finally {
        if (!cancelled) {
          challengeBusy.current = false;
          setStarting(false);
        }
      }
    };
    void start();

    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      window.removeEventListener("message", relay);
      const container = document.getElementById(QR_CONTAINER_ID);
      if (container) container.innerHTML = "";
    };
  }, [attempt]);

  const regenerate = () => {
    if (challengeBusy.current) return;
    resetQrStart();
    challengeBusy.current = true;
    setStarting(true);
    setAttempt((value) => value + 1);
  };

  return (
    <StatePage tone="info" title="钉钉扫码登录" detail={message}>
      <div id={QR_CONTAINER_ID} aria-label="钉钉登录二维码" style={{ width: 300, minHeight: 300, margin: "16px auto" }} />
      <Button disabled={starting} onClick={regenerate}>重新生成二维码</Button>
    </StatePage>
  );
}

export function QrRelayPage() {
  const [message, setMessage] = useState("正在接收钉钉授权结果…");
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const authCode = query.get("authCode") || query.get("code") || "";
    const state = query.get("state") || "";
    if (!authCode || !state) {
      setMessage("钉钉授权信息不完整，请返回登录页重新扫码。");
      return;
    }
    if (window.self !== window.top) {
      const message: QrRelayMessage = { type: QR_RELAY_MESSAGE, authCode, state };
      window.parent.postMessage(message, window.location.origin);
      setMessage("授权已通过，正在返回登录窗口…");
      return;
    }
    void completeQrCode(authCode, state, setMessage);
  }, []);
  return <StatePage tone="info" title="正在完成扫码登录" detail={message} />;
}

export function DeniedPage() { return <StatePage tone="danger" title="无法进入系统" detail="达兴组织、在职或账号启用状态未通过服务端校验。如有疑问，请联系管理员。"><Button onClick={() => window.location.assign(base)}>返回登录</Button></StatePage>; }
