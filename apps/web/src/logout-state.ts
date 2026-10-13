import { createWebUrls } from "../url-contract.js";
import { createClientRequestId } from "./client-request-id.js";

const { base } = createWebUrls(import.meta.env.BASE_URL);
export const logoutStorageKey = `dx-rework:logged-out:${base}`;
let memoryMarker: string | null = null;
let localWriteFailed = false;
const completedKey = `${logoutStorageKey}:completed`;
const loginIntentKey = `${logoutStorageKey}:login-intent`;
let memoryIntent: { marker: string | null } | undefined;
const listeners = new Set<() => void>();
let channel: BroadcastChannel | undefined;

function cookieMarker(key: string): string | null {
  if (typeof document === "undefined") return null;
  const name = `dx_rework_exit_${encodeURIComponent(key)}=`;
  return document.cookie.split(";").map(value => value.trim()).find(value => value.startsWith(name))?.slice(name.length) || null;
}

function rememberCookie(key: string, value: string | null): void {
  if (typeof document === "undefined") return;
  // This contains only logout intent, never a credential; the HttpOnly session
  // cookie is still revoked and cleared exclusively by the existing API.
  document.cookie = `dx_rework_exit_${encodeURIComponent(key)}=${value ?? ""}; Path=${base}; SameSite=Lax; Max-Age=${value ? 31536000 : 0}${window.location.protocol === "https:" ? "; Secure" : ""}`;
}

export function logoutMarker(): string | null {
  if (typeof window === "undefined") return memoryMarker;
  try {
    const stored = window.localStorage.getItem(logoutStorageKey);
    if (!localWriteFailed && stored !== null) return stored;
  } catch { /* Restricted containers use the tab fallback. */ }
  try { return window.sessionStorage.getItem(logoutStorageKey) ?? cookieMarker(logoutStorageKey) ?? memoryMarker; }
  catch { return cookieMarker(logoutStorageKey) ?? memoryMarker; }
}

function remember(marker: string | null, notify = true): void {
  const previous = logoutMarker();
  memoryMarker = marker;
  rememberCookie(logoutStorageKey, marker);
  for (const storage of ["localStorage", "sessionStorage"] as const) {
    try {
      if (marker === null) window[storage].removeItem(logoutStorageKey);
      else window[storage].setItem(logoutStorageKey, marker);
      if (storage === "localStorage") localWriteFailed = false;
    } catch { if (storage === "localStorage") localWriteFailed = true; }
  }
  if (notify && previous !== marker) for (const listener of listeners) listener();
}

export function markLoggedOut(): string {
  clearLoginIntent();
  const marker = createClientRequestId();
  remember(marker);
  channel?.postMessage({ marker });
  return marker;
}

export function completeExplicitLogin(expectedMarker: string | null): boolean {
  if (logoutMarker() !== expectedMarker) return false;
  if (expectedMarker) {
    rememberCookie(completedKey, expectedMarker);
    try { window.localStorage.setItem(completedKey, expectedMarker); } catch { /* The current tab still completes explicitly. */ }
  }
  clearLoginIntent();
  // This caller has just verified the login and immediately replaces its page.
  // Only sibling tabs recheck via storage; an old-page request would be aborted
  // by replacement and could incorrectly recreate the logout marker.
  remember(null, false);
  return true;
}

export function loginIntentStillCurrent(expectedMarker: string | null): boolean {
  return logoutMarker() === expectedMarker;
}

export function beginLoginIntent(marker: string | null): boolean {
  if (!loginIntentStillCurrent(marker)) return false;
  memoryIntent = { marker };
  try { window.sessionStorage.setItem(loginIntentKey, JSON.stringify(memoryIntent)); } catch { /* Same-document callbacks use memory. */ }
  return true;
}

export function currentLoginIntent(): string | null | undefined {
  let intent = memoryIntent;
  try {
    const raw = window.sessionStorage.getItem(loginIntentKey);
    if (raw) intent = JSON.parse(raw) as { marker: string | null };
  } catch { /* The optional intent does not grant business access. */ }
  return intent && (intent.marker === null || typeof intent.marker === "string") && loginIntentStillCurrent(intent.marker)
    ? intent.marker : undefined;
}

function clearLoginIntent(): void {
  memoryIntent = undefined;
  try { window.sessionStorage.removeItem(loginIntentKey); } catch { /* The marker check also invalidates old callbacks. */ }
}

export function subscribeLogout(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", changed);
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(logoutStorageKey);
      channel.onmessage = broadcast;
    }
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && typeof window !== "undefined") {
      window.removeEventListener("storage", changed);
      channel?.close(); channel = undefined;
    }
  };
}

function changed(event: StorageEvent): void {
  if (event.key !== logoutStorageKey) return;
  localWriteFailed = false;
  memoryMarker = event.newValue;
  if (event.newValue !== null) clearLoginIntent();
  try {
    if (event.newValue === null) window.sessionStorage.removeItem(logoutStorageKey);
    else window.sessionStorage.setItem(logoutStorageKey, event.newValue);
  } catch { /* The in-memory fallback is sufficient for this document. */ }
  for (const listener of listeners) listener();
}

function broadcast(event: MessageEvent<unknown>): void {
  if (typeof event.data !== "object" || event.data === null || !("marker" in event.data)
    || typeof event.data.marker !== "string") return;
  // Shared storage is authoritative when available; the channel supplies logout
  // to restricted containers. It never grants access or automatically logs in.
  let marker: string | null;
  try {
    marker = window.localStorage.getItem(logoutStorageKey);
    if (marker === null && (window.localStorage.getItem(completedKey) ?? cookieMarker(completedKey)) !== event.data.marker) marker = event.data.marker;
  }
  catch { marker = event.data.marker; }
  if (marker) { clearLoginIntent(); remember(marker); }
}
