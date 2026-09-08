import { mintAcceptanceControlCode } from "../../apps/api/src/auth/acceptance-control.js";

if (process.env.NODE_ENV !== "test" || process.env.ACCEPTANCE_LAB_ENABLED !== "true") {
  throw new Error("Acceptance control code requires NODE_ENV=test and ACCEPTANCE_LAB_ENABLED=true");
}
const secret = process.env.ACCEPTANCE_LAB_SECRET?.trim();
if (!secret) throw new Error("ACCEPTANCE_LAB_SECRET is required");
console.log(mintAcceptanceControlCode(secret));
