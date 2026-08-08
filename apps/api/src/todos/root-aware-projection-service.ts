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
  );

/**
 * Root single-user acceptance must be able to verify business state machines
 * before all real recipient accounts are configured. Only recipient-routing
 * availability conflicts are suppressed for Root-authored actions. Ordinary
 * users, independent-approver rules and all other Todo failures stay strict.
 */
export class RootAwareTodoProjectionService extends TodoProjectionService {
  constructor(todos: TodoService) {
    super(todos);
  }

  override async actionableForUniqueDirectRole(
    ...args: Parameters<TodoProjectionService["actionableForUniqueDirectRole"]>
  ): Promise<void> {
    try {
      await super.actionableForUniqueDirectRole(...args);
    } catch (error: unknown) {
      if (rootActor(args[1]) && isAcceptanceRoutingConflict(error)) return;
      throw error;
    }
  }

  override async actionableForUniqueDirectRoleExcluding(
    ...args: Parameters<TodoProjectionService["actionableForUniqueDirectRoleExcluding"]>
  ): Promise<void> {
    try {
      await super.actionableForUniqueDirectRoleExcluding(...args);
    } catch (error: unknown) {
      if (rootActor(args[1]) && isAcceptanceRoutingConflict(error)) return;
      throw error;
    }
  }

  override async actionableForUniqueRoleOrOrderDelegate(
    ...args: Parameters<TodoProjectionService["actionableForUniqueRoleOrOrderDelegate"]>
  ): Promise<void> {
    try {
      await super.actionableForUniqueRoleOrOrderDelegate(...args);
    } catch (error: unknown) {
      if (rootActor(args[1]) && isAcceptanceRoutingConflict(error)) return;
      throw error;
    }
  }
}
