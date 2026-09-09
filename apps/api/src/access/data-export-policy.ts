import type { TrustedActorContext } from "../tools/repositories.js";
import { assertBusinessExportAllowed, assertWageDataExportAllowed } from "./export-authority.js";

export type DataExportScope = "general" | "wages";

export function assertDataExportPolicy(
  actor: TrustedActorContext,
  scope: DataExportScope,
): void {
  if (scope === "wages") {
    assertWageDataExportAllowed(actor.actorRoles);
    return;
  }
  assertBusinessExportAllowed(actor.actorRoles);
}
