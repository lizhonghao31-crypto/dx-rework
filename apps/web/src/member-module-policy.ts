import { verifySession } from "./auth.js";

type PolicyUser = { isRoot?: boolean; readOnlyModules?: readonly ("rework" | "sourcing")[] };
export function moduleCanWrite(user: PolicyUser | null, module: "rework" | "sourcing"): boolean {
  return user !== null && (user.isRoot === true || !user.readOnlyModules?.includes(module));
}

export async function currentModuleCanWrite(module: "rework" | "sourcing"): Promise<boolean> {
  const session = await verifySession();
  return session !== "denied" && session.status === "authorized" && moduleCanWrite(session.user, module);
}
