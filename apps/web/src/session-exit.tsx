import { useState } from "react";
import { createWebUrls } from "../url-contract.js";
import { invalidateSession } from "./auth-session.js";
import { canLeaveInternalPage } from "./internal-navigation.js";
import { markLoggedOut } from "./logout-state.js";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);
let exiting: Promise<boolean> | undefined;

/** One request, after the existing leave guards have accepted. */
export function exitCurrentSession(): Promise<boolean> {
  exiting ??= (async () => {
    if (!await canLeaveInternalPage()) return false;
    const response = await fetch(apiUrl("auth/logout"), { method: "POST", credentials: "include", cache: "no-store" });
    if (response.status !== 204) throw new Error("退出登录未完成，请重试。");
    invalidateSession();
    markLoggedOut();
    window.location.replace(pageUrl("auth/logged-out"));
    return true;
  })().finally(() => { exiting = undefined; });
  return exiting;
}

export function LogoutButton({ mobile = false }: { mobile?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const exit = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try { await exitCurrentSession(); }
    catch { setError("退出登录未完成，请检查网络后重试。"); }
    finally { setBusy(false); }
  };
  return <>
    <button type="button" className={`session-logout${mobile ? " session-logout--mobile" : ""}`} disabled={busy} onClick={() => void exit()}>
      <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 3H4v14h4M8 10h9m-3-3 3 3-3 3" />
      </svg><span>{busy ? "正在退出…" : "退出登录"}</span>
    </button>
    {error ? <p className="session-logout-error" role="alert">{error}</p> : null}
  </>;
}
