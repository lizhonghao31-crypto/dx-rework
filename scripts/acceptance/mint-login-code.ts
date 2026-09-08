import { mintAcceptanceLoginCode } from "../../apps/api/src/auth/acceptance-provider.js";

const alias = process.argv[2]?.trim();
const secret = process.env.ACCEPTANCE_LAB_SECRET?.trim();
if (process.env.NODE_ENV !== "test" || process.env.ACCEPTANCE_LAB_ENABLED !== "true") {
  throw new Error("Acceptance login code minting requires NODE_ENV=test and ACCEPTANCE_LAB_ENABLED=true");
}
if (!alias) throw new Error("Usage: npx tsx scripts/acceptance/mint-login-code.ts <role-alias>");
if (!secret) throw new Error("ACCEPTANCE_LAB_SECRET is required");

process.stdout.write(`${mintAcceptanceLoginCode(alias, secret)}\n`);
