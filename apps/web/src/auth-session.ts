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
  for (const reset of invalidators) reset();
}

export function cachedSessionVerificationResult(){return verifiedResult;}
export function cachedVerifiedSession(): VerifiedSession | undefined {
  return verifiedResult?.session;
}

/** The public entry and protected pages share one request and its result. */
export function verifySessionResult(force = false): Promise<SessionVerificationResult> {
  if (force) {
    invalidateSession();
  }
  if (verifiedResult !== undefined) return Promise.resolve(verifiedResult);

  if (!sessionVerification) {
    const version = ++sessionVerificationVersion;
    sessionVerification = fetch(apiUrl("auth/me"), { credentials: "include", cache: "no-store" })
      .then(async (response): Promise<SessionVerificationResult> => {
        if(!response.ok)return {session:"denied",requestFailed:![401,403].includes(response.status)};
        const value:unknown=await response.json();
        if(!validSession(value))return {session:"denied",requestFailed:true};
        return {session:value,requestFailed:false};
      })
      .catch((error): SessionVerificationResult => (error?.name==='AbortError'?{session:"denied",requestFailed:false,cancelled:true}:{ session: "denied", requestFailed: true }))
      .then((result): SessionVerificationResult => {
        if (version !== sessionVerificationVersion) return { session: "denied", requestFailed: false };
        if(result.cancelled){sessionVerification=undefined;return result;}
        verifiedResult = result;
        return result;
      });
  }
  return sessionVerification;
}

/** Preserve the existing fail-closed contract for every current caller. */
export function verifySession(force = false): Promise<VerifiedSession> {
  return verifySessionResult(force).then((result) => result.session);
}

function validSession(value:unknown):value is AuthorizedSession{
 if(!value||typeof value!=='object'||!('status'in value)||!['authorized','no_role'].includes(String(value.status))||!('user'in value)||!value.user||typeof value.user!=='object')return false;
 const user=value.user as Record<string,unknown>,strings=(v:unknown)=>Array.isArray(v)&&v.every(item=>typeof item==='string');
 return typeof user.id==='string'&&typeof user.displayName==='string'&&strings(user.capabilities)
  &&(user.businessRoles===undefined||strings(user.businessRoles))&&(user.isRoot===undefined||typeof user.isRoot==='boolean')
  &&(user.effectiveWriteCapabilities===undefined||strings(user.effectiveWriteCapabilities))&&(user.readOnlyModules===undefined||Array.isArray(user.readOnlyModules)&&user.readOnlyModules.every(item=>['rework','sourcing'].includes(item)));
}
