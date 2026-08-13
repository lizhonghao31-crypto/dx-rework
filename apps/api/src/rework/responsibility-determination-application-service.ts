import type {
  ConfirmHighMultiplier,
  CreateResponsibilityDraft,
  FinalizeResponsibility,
  OwnerSignatureCommand,
  ResponsibilityDeterminationResponse,
  TakeoverResponsibility,
  TransferResponsibility,
} from "@dx-rework/contracts";
import type { Pool } from "pg";

import { isRootActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";
import { AuthorizedResponsibilityDeterminationService } from "./responsibility-determination-authorized-service.js";
import { ResponsibilityDeterminationQueueService } from "./responsibility-determination-queue-service.js";
import { ResponsibilityOwnerSignatureService } from "./responsibility-owner-signature-service.js";
import {
  decimalToScaled,
  ResponsibilityDeterminationService,
} from "./responsibility-determination-service.js";

type TransferPermissionRow = Readonly<{
  status: string;
  handler_user_id: string | null;
  permitted: boolean;
}>;

type TransferCandidateRow = Readonly<{
  user_id: string;
  display_name: string;
}>;

const baseAmountToBusinessAmount = (value: string): string => {
  const scale8 = decimalToScaled(value, 8);
  const mills = (scale8 + 50_000n) / 100_000n;
  const fraction = (mills % 1_000n).toString().padStart(3, "0");
  return `${mills / 1_000n}.${fraction.endsWith("0") ? fraction.slice(0, -1) : fraction}`;
};

export const normalizeResponsibilityAmountView = (
  value: ResponsibilityDeterminationResponse,
): ResponsibilityDeterminationResponse => ({
  ...value,
  sourceProcesses: value.sourceProcesses.map((process) => ({
    ...process,
    baseAmount: baseAmountToBusinessAmount(process.baseAmount),
  })),
  determination: value.determination
    ? {
        ...value.determination,
        processes: value.determination.processes.map((process) => ({
          ...process,
          baseAmount: baseAmountToBusinessAmount(process.baseAmount),
        })),
      }
    : null,
});

/**
 * Production-facing responsibility application service.
 *
 * Responsibility calculations remain exact and final financial amounts remain
 * two-decimal money. The business-facing base amount keeps up to three decimals
 * and does not expose legacy eight-decimal storage formatting.
 */
export class ResponsibilityDeterminationApplicationService {
  private readonly draftEngine: ResponsibilityDeterminationService;
  private readonly authorized: AuthorizedResponsibilityDeterminationService;
  private readonly queue: ResponsibilityDeterminationQueueService;
  private readonly ownerSignatures: ResponsibilityOwnerSignatureService;

  constructor(
    private readonly database: Pool,
    todos?: TodoProjectionService,
  ) {
    this.draftEngine = new ResponsibilityDeterminationService(
      database,
      undefined,
      undefined,
      todos,
    );
    this.authorized = new AuthorizedResponsibilityDeterminationService(
      database,
      todos,
    );
    this.queue = new ResponsibilityDeterminationQueueService(database);
    this.ownerSignatures = new ResponsibilityOwnerSignatureService(database, todos);
  }

  listQueue(
    ...args: Parameters<ResponsibilityDeterminationQueueService["list"]>
  ) {
    return this.queue.list(...args);
  }

  async get(...args: Parameters<AuthorizedResponsibilityDeterminationService["get"]>) {
    return normalizeResponsibilityAmountView(await this.authorized.get(...args));
  }

  async listTransferCandidates(
    actor: TrustedActorContext,
    orderId: string,
  ): Promise<{ items: Array<{ userId: string; displayName: string }> }> {
    const permissionResult = await this.database.query<TransferPermissionRow>(
      `SELECT o.status,
              responsibility_effective_handler(o.rework_order_id) handler_user_id,
              responsibility_can_determine($1,o.rework_order_id) permitted
       FROM rework_orders o
       WHERE o.rework_order_id=$2 AND o.status<>'deleted'`,
      [actor.actorId, orderId],
    );
    const permission = permissionResult.rows[0];
    if (!permission) {
      throw new ApplicationError("NOT_FOUND", "返工单不存在", 404);
    }
    const capabilities = actor.authorizationCapabilities ?? [actor.authorizationCapability];
    if (
      permission.status !== "pending_responsibility_determination"
      || permission.permitted !== true
      || !capabilities.includes("responsibility:determine")
      || (!isRootActor(actor) && permission.handler_user_id !== actor.actorId)
    ) {
      throw new ApplicationError("FORBIDDEN", "只有当前有效责任处理人可以查看转交对象", 403);
    }

    const candidates = await this.database.query<TransferCandidateRow>(
      `SELECT u.id user_id,u.display_name
       FROM app_users u
       WHERE (u.id<>$1 OR $3::boolean)
         AND responsibility_can_determine(u.id,$2)
       ORDER BY u.display_name,u.id`,
      [actor.actorId, orderId, isRootActor(actor) && permission.handler_user_id === null],
    );
    return {
      items: candidates.rows.map((row) => ({
        userId: row.user_id,
        displayName: row.display_name,
      })),
    };
  }

  /** Supplier master data is selected while production management prepares
   * N07.  N08 only signs the resulting immutable snapshots; it never asks an
   * owner or payables user to choose a supplier again. */
  async listSupplierOptions(
    actor: TrustedActorContext,
    orderId: string,
  ): Promise<{
    items: Array<{
      supplierId: string;
      supplierType: "factory" | "embroidery_washing" | "fabric";
      supplierName: string;
    }>;
  }> {
    const order = await this.database.query<{
      status: string;
      permitted: boolean;
    }>(
      `SELECT status,responsibility_can_determine($1,rework_order_id) permitted
       FROM rework_orders
       WHERE rework_order_id=$2 AND status<>'deleted'`,
      [actor.actorId, orderId],
    );
    const row = order.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "返工单不存在", 404);
    const caps = actor.authorizationCapabilities ?? [actor.authorizationCapability];
    if (
      row.status !== "pending_responsibility_determination"
      || (!isRootActor(actor) && (!row.permitted || !caps.includes("responsibility:determine")))
    ) {
      throw new ApplicationError("FORBIDDEN", "只有当前责任判定处理人可以选择供应商", 403);
    }
    const suppliers = await this.database.query<{
      supplier_id: string;
      supplier_type: "factory" | "embroidery_washing" | "fabric";
      supplier_name: string;
    }>(
      `SELECT supplier_id,supplier_type,supplier_name
       FROM current_supplier_catalog
       WHERE active=true
       ORDER BY supplier_type,supplier_name,supplier_id`,
    );
    return {
      items: suppliers.rows.map((supplier) => ({
        supplierId: supplier.supplier_id,
        supplierType: supplier.supplier_type,
        supplierName: supplier.supplier_name,
      })),
    };
  }

  async saveDraft(
    actor: TrustedActorContext,
    orderId: string,
    input: CreateResponsibilityDraft,
    key: string,
  ) {
    if (
      input.processes.some((process) =>
        process.allocations.some((allocation) => allocation.shareBps <= 0),
      )
    ) {
      throw new ApplicationError(
        "VALIDATION_ERROR",
        "Responsibility shares must be greater than zero",
        400,
      );
    }
    // There is no persisted handler for the first N07 draft. Bind that first
    // draft to the eligible actor on the server, rather than relying on a
    // nullable UI field or allowing a browser to nominate another user.
    const normalizedInput = input.expectedCurrentDeterminationVersion === null
      && !isRootActor(actor)
      ? { ...input, handlerUserId: actor.actorId }
      : input;
    if (input.expectedCurrentDeterminationVersion === null && isRootActor(actor)) {
      const candidate = await this.database.query<{ permitted: boolean }>(
        "SELECT responsibility_can_determine($1,$2) permitted",
        [normalizedInput.handlerUserId, orderId],
      );
      if (candidate.rows[0]?.permitted !== true) {
        throw new ApplicationError(
          "VALIDATION_ERROR",
          "请为初始责任判定选择有权限的处理人",
          400,
        );
      }
    }
    const result = await this.draftEngine.saveDraft(actor, orderId, normalizedInput, key);
    return { ...result, value: normalizeResponsibilityAmountView(result.value) };
  }

  async finalize(
    actor: TrustedActorContext,
    orderId: string,
    input: FinalizeResponsibility,
    key: string,
  ) {
    const result = await this.authorized.finalize(actor, orderId, input, key);
    return { ...result, value: normalizeResponsibilityAmountView(result.value) };
  }

  async transfer(
    actor: TrustedActorContext,
    orderId: string,
    input: TransferResponsibility,
    key: string,
  ) {
    const result = await this.authorized.transfer(actor, orderId, input, key);
    return { ...result, value: normalizeResponsibilityAmountView(result.value) };
  }

  async takeover(
    actor: TrustedActorContext,
    orderId: string,
    input: TakeoverResponsibility,
    key: string,
  ) {
    const result = await this.authorized.takeover(actor, orderId, input, key);
    return { ...result, value: normalizeResponsibilityAmountView(result.value) };
  }

  async confirmHighMultiplier(
    actor: TrustedActorContext,
    determinationId: string,
    input: ConfirmHighMultiplier,
    key: string,
  ) {
    const result = await this.authorized.confirmHighMultiplier(
      actor,
      determinationId,
      input,
      key,
    );
    return { ...result, value: normalizeResponsibilityAmountView(result.value) };
  }

  async approveOwnerSignature(
    actor: TrustedActorContext,
    orderId: string,
    input: OwnerSignatureCommand,
    key: string,
  ) {
    const result = await this.ownerSignatures.approve(actor, orderId, input, key);
    return { ...result, value: normalizeResponsibilityAmountView(result.value) };
  }

  async rejectOwnerSignature(
    actor: TrustedActorContext,
    orderId: string,
    input: OwnerSignatureCommand,
    key: string,
  ) {
    const result = await this.ownerSignatures.reject(actor, orderId, input, key);
    return { ...result, value: normalizeResponsibilityAmountView(result.value) };
  }
}
