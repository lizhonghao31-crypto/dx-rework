import type { SampleCapability } from "@dx-rework/contracts";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import { isRootActor } from "../access/business-authority.js";

const designer: readonly SampleCapability[] = ["sample:view_basic", "sample:borrow_request", "sample:return_request"];
const administrative: readonly SampleCapability[] = [
  "sample:view_basic", "sample:view_audit", "sample:borrow_confirm", "sample:return_confirm",
  "sample:update_basic", "sample:update_location", "sample:dispose_request", "sample:loss_close",
];
const finance: readonly SampleCapability[] = [
  "sample:view_basic", "sample:view_finance", "sample:view_audit", "sample:create", "sample:batch_create", "sample:update_basic", "sample:correct_finance",
];
const financeDirectorReadOnly: readonly SampleCapability[] = [
  "sample:view_basic", "sample:view_finance", "sample:view_audit",
];
const owner: readonly SampleCapability[] = [
  ...designer, "sample:view_finance", "sample:view_audit", "sample:dispose_request", "sample:dispose_approve",
];
export const SAMPLE_ROLE_CAPABILITIES: Readonly<Record<string, readonly SampleCapability[]>> = {
  sample_designer: designer, sample_administrative: administrative, sample_finance: finance, owner_group: owner,
  finance_director: financeDirectorReadOnly,
  finance_read: financeDirectorReadOnly,
};

// Only accept a server-built actor (businessActor/RootAuthority), never request-body roles.
export function canUseSampleCapability(actor: TrustedActorContext, capability: SampleCapability): boolean {
  if (isRootActor(actor)) return true;
  const capabilities = actor.authorizationCapabilities ?? [actor.authorizationCapability];
  return capabilities.includes(capability)
    && actor.actorRoles.some((role) => SAMPLE_ROLE_CAPABILITIES[role]?.includes(capability));
}

export function requireSampleCapability(actor: TrustedActorContext, capability: SampleCapability): void {
  if (!canUseSampleCapability(actor, capability)) {
    throw new ApplicationError("FORBIDDEN", "当前身份无权执行此样衣操作", 403);
  }
}
