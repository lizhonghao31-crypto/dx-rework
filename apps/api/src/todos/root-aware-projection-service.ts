import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import { TodoProjectionService } from "./projection-service.js";
import type { TodoService } from "./service.js";

const rootActor = (actor: TrustedActorContext): boolean =>
  actor.actorRoles.includes("root_superuser");

const isAcceptanceRoutingConflict = (error: unknown): boolean =>
  error instanceof ApplicationError
  && error.code === "CONFLICT"
  && (
    error.message.includes("Todo recipient is not uniquely routable")
    || error.message.includes("Finance todo has multiple direct recipients")
    || error.message.includes("Finance todo recipient is not uniquely routable")
    || error.message.includes("Todo recipient is no longer eligible")
    || error.message.includes("Shared role todo has no currently eligible direct recipient")
    || error.message.includes("Assigned business role todo has no currently eligible direct recipient")
    || error.message.includes("Parallel todo recipients exceed the approved direct-role rule")
    || error.message.includes("A fully unavailable parallel todo has no stable original recipient")
    || error.message.includes("A recipient routing exception requires one direct production-management assignee")
    || error.message.includes("High-multiplier confirmation requires one independent direct owner-group recipient")
    || error.message.includes("Responsibility handler has multiple direct roles; a single todo authority fact is required")
    || error.message.includes("Responsibility handler is not uniquely routable from an active direct role or order delegation")
    || error.message.includes("The original actionable actor cannot be verified from the source operation event")
    || error.message.includes("The source operation event does not identify one actionable business role")
    || error.message.includes("Named business handler has multiple active order delegates")
  );

/**
 * Root is the single-account business acceptance identity. Recipient-routing
 * availability, actor separation, or missing real-role assignees must not roll
 * back an otherwise valid Root-authored business transaction. Ordinary users
 * remain strict. Source-event mismatches, disabled policies, duplicate facts,
 * state-machine errors, and other data-integrity failures are never suppressed.
 */
export class RootAwareTodoProjectionService extends TodoProjectionService {
  constructor(todos: TodoService) {
    super(todos);
  }

  private suppress(actor: TrustedActorContext, error: unknown): boolean {
    return rootActor(actor) && isAcceptanceRoutingConflict(error);
  }

  override async actionableForUniqueDirectRole(
    ...args: Parameters<TodoProjectionService["actionableForUniqueDirectRole"]>
  ): Promise<void> {
    try {
      await super.actionableForUniqueDirectRole(...args);
    } catch (error: unknown) {
      if (this.suppress(args[1], error)) return;
      throw error;
    }
  }

  override async actionableForUniqueDirectRoleExcluding(
    ...args: Parameters<TodoProjectionService["actionableForUniqueDirectRoleExcluding"]>
  ): Promise<void> {
    try {
      await super.actionableForUniqueDirectRoleExcluding(...args);
    } catch (error: unknown) {
      if (this.suppress(args[1], error)) return;
      throw error;
    }
  }

  override async actionableForParallelDirectRole(
    ...args: Parameters<TodoProjectionService["actionableForParallelDirectRole"]>
  ): Promise<string[]> {
    try {
      return await super.actionableForParallelDirectRole(...args);
    } catch (error: unknown) {
      if (this.suppress(args[1], error)) return [];
      throw error;
    }
  }

  override async actionableForAllDirectRole(
    ...args: Parameters<TodoProjectionService["actionableForAllDirectRole"]>
  ): Promise<string[]> {
    try {
      return await super.actionableForAllDirectRole(...args);
    } catch (error: unknown) {
      if (this.suppress(args[1], error)) return [];
      throw error;
    }
  }

  override async actionableForAllAssignedRole(
    ...args: Parameters<TodoProjectionService["actionableForAllAssignedRole"]>
  ): Promise<string[]> {
    try {
      return await super.actionableForAllAssignedRole(...args);
    } catch (error: unknown) {
      if (this.suppress(args[1], error)) return [];
      throw error;
    }
  }

  override async actionableForRecipient(
    ...args: Parameters<TodoProjectionService["actionableForRecipient"]>
  ): Promise<void> {
    try {
      await super.actionableForRecipient(...args);
    } catch (error: unknown) {
      if (this.suppress(args[1], error)) return;
      throw error;
    }
  }

  override async actionableForNamedRecipient(
    ...args: Parameters<TodoProjectionService["actionableForNamedRecipient"]>
  ): Promise<void> {
    try {
      await super.actionableForNamedRecipient(...args);
    } catch (error: unknown) {
      if (this.suppress(args[1], error)) return;
      throw error;
    }
  }

  override async actionableForNamedRoleOrOrderDelegate(
    ...args: Parameters<TodoProjectionService["actionableForNamedRoleOrOrderDelegate"]>
  ): Promise<void> {
    try {
      await super.actionableForNamedRoleOrOrderDelegate(...args);
    } catch (error: unknown) {
      if (this.suppress(args[1], error)) return;
      throw error;
    }
  }

  override async actionableForIndependentOwner(
    ...args: Parameters<TodoProjectionService["actionableForIndependentOwner"]>
  ): Promise<void> {
    try {
      await super.actionableForIndependentOwner(...args);
    } catch (error: unknown) {
      if (this.suppress(args[1], error)) return;
      throw error;
    }
  }

  override async actionableForResponsibilityHandler(
    ...args: Parameters<TodoProjectionService["actionableForResponsibilityHandler"]>
  ): Promise<void> {
    try {
      await super.actionableForResponsibilityHandler(...args);
    } catch (error: unknown) {
      if (this.suppress(args[1], error)) return;
      throw error;
    }
  }

  override async actionableForUniqueRoleOrOrderDelegate(
    ...args: Parameters<TodoProjectionService["actionableForUniqueRoleOrOrderDelegate"]>
  ): Promise<void> {
    try {
      await super.actionableForUniqueRoleOrOrderDelegate(...args);
    } catch (error: unknown) {
      if (this.suppress(args[1], error)) return;
      throw error;
    }
  }

  override async actionableForNamedSourceActor(
    ...args: Parameters<TodoProjectionService["actionableForNamedSourceActor"]>
  ): Promise<void> {
    try {
      await super.actionableForNamedSourceActor(...args);
    } catch (error: unknown) {
      if (this.suppress(args[1], error)) return;
      throw error;
    }
  }
}
