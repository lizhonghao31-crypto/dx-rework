import { createWebUrls } from "../url-contract.js";
import type { AuthorizedSession } from "./auth.js";

export type VerifiedSession = "denied" | AuthorizedSession;
export type SessionVerificationResult = {
  session: VerifiedSession;
  requestFailed: boolean;
};

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
let verifiedResult: SessionVerificationResult | undefined;
let sessionVerification: Promise<SessionVerificationResult> | undefined;
let sessionVerificationVersion = 0;

export function cachedVerifiedSession(): VerifiedSession | undefined {
  return verifiedResult?.session;
}

/** The public entry and protected pages share one request and its result. */
export function verifySessionResult(force = false): Promise<SessionVerificationResult> {
  if (force) {
    verifiedResult = undefined;
    sessionVerification = undefined;
  }
  if (verifiedResult !== undefined) return Promise.resolve(verifiedResult);

  if (!sessionVerification) {
    const version = ++sessionVerificationVersion;
    sessionVerification = fetch(apiUrl("auth/me"), { credentials: "include", cache: "no-store" })
      .then(async (response): Promise<SessionVerificationResult> => ({
        session: response.ok ? await response.json() as AuthorizedSession : "denied",
        requestFailed: false,
      }))
      .catch((): SessionVerificationResult => ({ session: "denied", requestFailed: true }))
      .then((result): SessionVerificationResult => {
        if (version === sessionVerificationVersion) verifiedResult = result;
        return result;
      });
  }
  return sessionVerification;
}

/** Preserve the existing fail-closed contract for every current caller. */
export function verifySession(force = false): Promise<VerifiedSession> {
  return verifySessionResult(force).then((result) => result.session);
}
