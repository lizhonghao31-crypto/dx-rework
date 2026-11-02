import { createWebUrls } from "../url-contract.js";
import type { AuthorizedSession } from "./auth.js";

export type VerifiedSession = "denied" | AuthorizedSession;
export type SessionVerificationResult = {
  session: VerifiedSession;
  requestFailed: boolean;
  cancelled?:boolean;
};

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
let verifiedResult: SessionVerificationResult | undefined;
let sessionVerification: Promise<SessionVerificationResult> | undefined;
let sessionVerificationVersion = 0;
const invalidators = new Set<() => void>();

export function sessionCacheVersion(): number { return sessionVerificationVersion; }
export function registerSessionInvalidator(reset: () => void): () => void { invalidators.add(reset); return ()=>{invalidators.delete(reset);}; }
export function invalidateSession(): void {
  ++sessionVerificationVersion;
  verifiedResult = undefined;
  sessionVerification = undefined;
  verificationPending = false;
  for (const reset of invalidators) reset();
}

export function cachedSessionVerificationResult(){return verifiedResult;}
export function cachedVerifiedSession(): VerifiedSession | undefined {
  return verifiedResult?.session;
}

/** A bounded transport read, not a business deadline or a longer session cache. */
export const SESSION_READ_TIMEOUT_MS = 10_000;
let verificationPending = false;

function identityFingerprint(result: SessionVerificationResult | undefined): string {
  if (!result || result.session === "denied") return JSON.stringify(result);
  const { status, user } = result.session;
  return JSON.stringify({status,id:user.id,name:user.displayName,isRoot:user.isRoot === true,
    roles:[...(user.businessRoles ?? [])].sort(),capabilities:[...user.capabilities].sort(),
    effective:user.effectiveWriteCapabilities === undefined ? null : [...user.effectiveWriteCapabilities].sort(),
    readonly:[...(user.readOnlyModules ?? [])].sort(),requestFailed:result.requestFailed});
}

/** Stable identity/role key for read caches; an unchanged revalidation does not discard valid data. */
export function verifiedSessionIdentity(session:VerifiedSession|undefined):string{
  return identityFingerprint(session===undefined?undefined:{session,requestFailed:false});
}

function readIdentity(): Promise<SessionVerificationResult> {
  const controller = new AbortController();
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: SessionVerificationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({session:"denied",requestFailed:true});
      controller.abort();
    }, SESSION_READ_TIMEOUT_MS);
    void fetch(apiUrl("auth/me"), {credentials:"include",cache:"no-store",signal:controller.signal})
      .then(async (response): Promise<SessionVerificationResult> => {
        if (!response.ok) return {session:"denied",requestFailed:![401,403].includes(response.status)};
        const value: unknown = await response.json();
        return validSession(value) ? {session:value,requestFailed:false} : {session:"denied",requestFailed:true};
      })
      .then(finish, error => finish(error?.name === "AbortError"
        ? {session:"denied",requestFailed:false,cancelled:true}
        : {session:"denied",requestFailed:true}));
  });
}

function startVerification(notifyChangedIdentity = false): Promise<SessionVerificationResult> {
  const previous = verifiedResult;
  const version = ++sessionVerificationVersion;
  verificationPending = true;
  sessionVerification = readIdentity().then(result => {
    if (version !== sessionVerificationVersion) return {session:"denied",requestFailed:false};
    verificationPending = false;
    if (result.cancelled) {
      sessionVerification = undefined;
      if (notifyChangedIdentity) {
        verifiedResult = {session:"denied",requestFailed:true,cancelled:true};
        for (const reset of invalidators) reset();
        return verifiedResult;
      }
      return result;
    }
    verifiedResult = result;
    // An unchanged revalidation must not unmount the page which requested it.
    // Identity/role/permission changes and failed reads still invalidate every dependent view.
    if (notifyChangedIdentity && identityFingerprint(previous) !== identityFingerprint(result)) {
      for (const reset of invalidators) reset();
    }
    return result;
  });
  return sessionVerification;
}

/** The public entry and protected pages share one request and its result. */
export function verifySessionResult(force = false): Promise<SessionVerificationResult> {
  if (force) invalidateSession();
  if (verifiedResult !== undefined) return Promise.resolve(verifiedResult);
  return sessionVerification ?? startVerification();
}

/** Recheck on task entry without broadcasting an unchanged identity as a logout. */
export function refreshSessionResult(): Promise<SessionVerificationResult> {
  if (verificationPending && sessionVerification) return sessionVerification;
  return startVerification(true);
}
export function refreshSession(): Promise<VerifiedSession> {
  return refreshSessionResult().then(result => result.session);
}

/** Explicit identity changes retain the existing strong invalidation contract. */
export function verifySession(force = false): Promise<VerifiedSession> {
  return verifySessionResult(force).then(result => result.session);
}

function validSession(value:unknown):value is AuthorizedSession{
 if(!value||typeof value!=='object'||!('status'in value)||!['authorized','no_role'].includes(String(value.status))||!('user'in value)||!value.user||typeof value.user!=='object')return false;
 const user=value.user as Record<string,unknown>,strings=(v:unknown)=>Array.isArray(v)&&v.every(item=>typeof item==='string');
 return typeof user.id==='string'&&typeof user.displayName==='string'&&strings(user.capabilities)
  &&(user.businessRoles===undefined||strings(user.businessRoles))&&(user.isRoot===undefined||typeof user.isRoot==='boolean')
  &&(user.effectiveWriteCapabilities===undefined||strings(user.effectiveWriteCapabilities))&&(user.readOnlyModules===undefined||Array.isArray(user.readOnlyModules)&&user.readOnlyModules.every(item=>['rework','sourcing'].includes(item)));
}
