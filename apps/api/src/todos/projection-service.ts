import type { PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type {
  TodoService,
  CreateTodoInTransactionInput,
  TodoRouteTemplate,
} from "./service.js";

type ActionableProjection = Readonly<{
  category: string;
  sourceEventId: string;
  sourceAction: string;
  entityType: string;
  entityId: string;
  requiredRole: string;
  requiredCapability: string;
  route: TodoRouteTemplate;
  policyKey: "general" | "finance_return_or_wage_review" | "deduction_follow_up";
  authoritativeDueAt?: Date;
  delegationScopeId?: string;
  dedupeKey: string;
}>;

type InformationProjection = Readonly<{
  category: string;
  sourceEventId: string;
  sourceAction: string;
  entityType: string;
  entityId: string;
  recipientUserId: string;
  route: TodoRouteTemplate;
  dedupeKey: string;
}>;

type ResponsibilityHandlerProjection = Readonly<{
  category: string;
  sourceEventId: string;
  sourceAction: string;
  entityType: string;
  entityId: string;
  recipientUserId: string;
  route: TodoRouteTemplate;
  dedupeKey: string;
}>;

type NamedSourceActorProjection = Readonly<{
  category: string;
  sourceEventId: string;
  sourceAction: string;
  entityType: string;
  entityId: string;
  recipientUserId: string;
  sourceActorEventId: string;
  permittedCapabilities: readonly string[];
  route: TodoRouteTemplate;
  policyKey: "general" | "finance_return_or_wage_review";
  dedupeKey: string;
}>;

/**
 * PR-13's only business-event projection seam. It is intentionally invoked
 * from the existing service transaction after the source operation event is
 * appended; it does not subscribe to a second event bus or re-implement any
 * business state transition.
 */
export class TodoProjectionService {
  constructor(private readonly todos: TodoService) {}

  async actionableForUniqueDirectRole(
    client: PoolClient,
    actor: TrustedActorContext,
    projection: ActionableProjection,
  ): Promise<void> {
    const recipients = await client.query<{ user_id: string }>(
      `SELECT DISTINCT assignment.user_id
       FROM user_role_assignments assignment
       WHERE assignment.role_code=$1 AND assignment.revoked_at IS NULL
         AND todo_user_has_direct_role(assignment.user_id,$1,$2)
       ORDER BY assignment.user_id
       LIMIT 2`,
      [projection.requiredRole, projection.requiredCapability],
    );
    if (recipients.rows.length !== 1) {
      throw new ApplicationError(
        "CONFLICT",
        "Todo recipient is not uniquely routable from the approved direct-role rule",
        409,
      );
    }
    await this.actionableForRecipient(client, actor, {
      ...projection,
      recipientUserId: recipients.rows[0]!.user_id,
    });
  }

  async actionableForUniqueDirectRoleExcluding(
    client: PoolClient,
    actor: TrustedActorContext,
    projection: ActionableProjection & Readonly<{ excludeUserId: string }>,
  ): Promise<void> {
    const recipients = await client.query<{ user_id: string }>(
      `SELECT DISTINCT assignment.user_id
       FROM user_role_assignments assignment
       WHERE assignment.role_code=$1 AND assignment.revoked_at IS NULL
         AND assignment.user_id<>$2
         AND todo_user_has_direct_role(assignment.user_id,$1,$3)
       ORDER BY assignment.user_id
       LIMIT 2`,
      [
        projection.requiredRole,
        projection.excludeUserId,
        projection.requiredCapability,
      ],
    );
    if (recipients.rows.length !== 1) {
      throw new ApplicationError(
        "CONFLICT",
        "Todo recipient is not uniquely routable after the required self-approval exclusion",
        409,
      );
    }
    await this.actionableForRecipient(client, actor, {
      ...projection,
      recipientUserId: recipients.rows[0]!.user_id,
    });
  }

  /**
   * Only use for an existing business rule that explicitly permits equal
   * parallel action. For an own-factory approval, one valid direct owner is
   * still sufficient to act; an unavailable peer is never replaced merely to
   * preserve a nominal recipient count. If no direct owner remains, each
   * known unavailable owner becomes a blocked todo with a routing exception.
   */
  async actionableForParallelDirectRole(
    client: PoolClient,
    actor: TrustedActorContext,
    projection: ActionableProjection & Readonly<{
      expectedRecipientCount: number;
    }>,
  ): Promise<string[]> {
    const recipients = await client.query<{ user_id: string }>(
      `SELECT DISTINCT assignment.user_id
       FROM user_role_assignments assignment
       WHERE assignment.role_code=$1 AND assignment.revoked_at IS NULL
         AND todo_user_has_direct_role(assignment.user_id,$1,$2)
       ORDER BY assignment.user_id
       LIMIT $3`,
      [
        projection.requiredRole,
        projection.requiredCapability,
        projection.expectedRecipientCount + 1,
      ],
    );
    if (recipients.rows.length > projection.expectedRecipientCount) {
      throw new ApplicationError(
        "CONFLICT",
        "Parallel todo recipients exceed the approved direct-role rule",
        409,
      );
    }
    if (recipients.rows.length === 0) {
      const unavailable = await client.query<{ user_id: string }>(
        `SELECT DISTINCT assignment.user_id
         FROM user_role_assignments assignment
         WHERE assignment.role_code=$1 AND assignment.revoked_at IS NULL
         ORDER BY assignment.user_id
         LIMIT $2`,
        [projection.requiredRole, projection.expectedRecipientCount],
      );
      if (unavailable.rows.length === 0) {
        throw new ApplicationError(
          "CONFLICT",
          "A fully unavailable parallel todo has no stable original recipient",
          409,
        );
      }
      for (const recipient of unavailable.rows) {
        await this.actionableForNamedRecipient(client, actor, {
          ...projection,
          recipientUserId: recipient.user_id,
          dedupeKey: `${projection.dedupeKey}:${recipient.user_id}`,
        });
      }
      return [];
    }
    for (const recipient of recipients.rows) {
      await this.actionableForRecipient(client, actor, {
        ...projection,
        recipientUserId: recipient.user_id,
        dedupeKey: `${projection.dedupeKey}:${recipient.user_id}`,
      });
    }
    return recipients.rows.map((recipient) => recipient.user_id);
  }

  /**
   * Use only for a business node intentionally shared by every currently
   * eligible direct role holder. Each person receives an independent todo;
   * the business service closes the entire dedupe prefix after any one acts.
   */
  async actionableForAllDirectRole(
    client: PoolClient,
    actor: TrustedActorContext,
    projection: ActionableProjection,
  ): Promise<string[]> {
    const recipients = await client.query<{ user_id: string }>(
      `SELECT DISTINCT recipient.user_id
       FROM (
         SELECT assignment.user_id
         FROM user_role_assignments assignment
         WHERE assignment.role_code=$1 AND assignment.revoked_at IS NULL
         UNION
         SELECT root.user_id
         FROM owner_bootstrap_consumptions root
         WHERE root.singleton=true
       ) recipient
       WHERE todo_user_has_direct_role(recipient.user_id,$1,$2)
       ORDER BY recipient.user_id`,
      [projection.requiredRole, projection.requiredCapability],
    );
    if (recipients.rows.length === 0) {
      throw new ApplicationError(
        "CONFLICT",
        "Shared role todo has no currently eligible direct recipient",
        409,
      );
    }
    for (const recipient of recipients.rows) {
      await this.actionableForRecipient(client, actor, {
        ...projection,
        recipientUserId: recipient.user_id,
        dedupeKey: `${projection.dedupeKey}:${recipient.user_id}`,
      });
    }
    return recipients.rows.map((recipient) => recipient.user_id);
  }

  async actionableForRecipient(
    client: PoolClient,
    actor: TrustedActorContext,
    projection: ActionableProjection & Readonly<{
      recipientUserId: string;
      delegationId?: string;
      invalidRecipientRouting?: CreateTodoInTransactionInput["invalidRecipientRouting"];
    }>,
  ): Promise<void> {
    await this.todos.createInTransaction(client, actor, {
      todoType: "business_action",
      category: projection.category,
      sourceEventId: projection.sourceEventId,
      sourceAction: projection.sourceAction,
      entityType: projection.entityType,
      entityId: projection.entityId,
      recipientUserId: projection.recipientUserId,
      requiredRole: projection.requiredRole,
      requiredCapability: projection.requiredCapability,
      ...(projection.delegationId ? { delegationId: projection.delegationId } : {}),
      ...(projection.delegationScopeId ? { delegationScopeId: projection.delegationScopeId } : {}),
      route: projection.route,
      policyKey: projection.policyKey,
      ...(projection.authoritativeDueAt ? { authoritativeDueAt: projection.authoritativeDueAt } : {}),
      dedupeKey: projection.dedupeKey,
      ...(projection.invalidRecipientRouting ? { invalidRecipientRouting: projection.invalidRecipientRouting } : {}),
    });
  }

  /**
   * Use this only when the business fact already names the recipient. A stale
   * recipient becomes a blocked todo plus a separately routed exception; it is
   * never silently reassigned to another member of the same role.
   */
  async actionableForNamedRecipient(
    client: PoolClient,
    actor: TrustedActorContext,
    projection: ActionableProjection & Readonly<{
      recipientUserId: string;
    }>,
  ): Promise<void> {
    const eligible = await client.query<{ eligible: boolean }>(
      "SELECT todo_user_has_direct_role($1::uuid,$2::text,$3::text) AS eligible",
      [projection.recipientUserId, projection.requiredRole, projection.requiredCapability],
    );
    if (eligible.rows[0]?.eligible) {
      await this.actionableForRecipient(client, actor, projection);
      return;
    }
    const managers = await client.query<{ user_id: string }>(
      `SELECT DISTINCT assignment.user_id
       FROM user_role_assignments assignment
       WHERE assignment.role_code='production_management' AND assignment.revoked_at IS NULL
         AND todo_user_has_direct_role(
           assignment.user_id,'production_management','todo:routing_exception_manage'
         )
       ORDER BY assignment.user_id
       LIMIT 2`,
    );
    if (managers.rows.length !== 1) {
      throw new ApplicationError(
        "CONFLICT",
        "A recipient routing exception requires one direct production-management assignee",
        409,
      );
    }
    await this.actionableForRecipient(client, actor, {
      ...projection,
      invalidRecipientRouting: {
        reason: "recipient_no_longer_directly_eligible",
        assignedToUserId: managers.rows[0]!.user_id,
      },
    });
  }

  async information(
    client: PoolClient,
    actor: TrustedActorContext,
    projection: InformationProjection,
  ): Promise<void> {
    await this.todos.createInTransaction(client, actor, {
      todoType: "information",
      category: projection.category,
      sourceEventId: projection.sourceEventId,
      sourceAction: projection.sourceAction,
      entityType: projection.entityType,
      entityId: projection.entityId,
      recipientUserId: projection.recipientUserId,
      route: projection.route,
      dedupeKey: projection.dedupeKey,
    });
  }

  async completeOpenByDedupeKey(
    client: PoolClient,
    actor: TrustedActorContext,
    dedupeKey: string,
    reason: string,
  ): Promise<boolean> {
    return this.todos.completeOpenByDedupeKey(client, actor, dedupeKey, reason);
  }

  async cancelOpenByDedupeKey(
    client: PoolClient,
    actor: TrustedActorContext,
    dedupeKey: string,
    reason: string,
  ): Promise<boolean> {
    return this.todos.cancelOpenByDedupeKey(client, actor, dedupeKey, reason);
  }

  async cancelOpenByDedupePrefix(
    client: PoolClient,
    actor: TrustedActorContext,
    dedupePrefix: string,
    reason: string,
  ): Promise<number> {
    return this.todos.cancelOpenByDedupePrefix(client, actor, dedupePrefix, reason);
  }

  async completeOpenByDedupePrefix(
    client: PoolClient,
    actor: TrustedActorContext,
    dedupePrefix: string,
    reason: string,
  ): Promise<number> {
    return this.todos.completeOpenByDedupePrefix(client, actor, dedupePrefix, reason);
  }

  /**
   * Use only when the source draft author is already a direct owner. The
   * source fact then leaves exactly one independent direct owner who may
   * confirm; the author is never eligible for their own confirmation todo.
   */
  async actionableForIndependentOwner(
    client: PoolClient,
    actor: TrustedActorContext,
    projection: ActionableProjection & Readonly<{ excludeUserId: string }>,
  ): Promise<void> {
    const recipients = await client.query<{ user_id: string }>(
      `SELECT DISTINCT assignment.user_id
       FROM user_role_assignments assignment
       WHERE assignment.role_code='owner_group' AND assignment.revoked_at IS NULL
         AND assignment.user_id<>$1
         AND todo_user_has_direct_role(
           assignment.user_id,'owner_group','responsibility:confirm_high_multiplier'
         )
       ORDER BY assignment.user_id
       LIMIT 2`,
      [projection.excludeUserId],
    );
    if (recipients.rows.length !== 1) {
      throw new ApplicationError(
        "CONFLICT",
        "High-multiplier confirmation requires one independent direct owner-group recipient",
        409,
      );
    }
    await this.actionableForRecipient(client, actor, {
      ...projection,
      recipientUserId: recipients.rows[0]!.user_id,
    });
  }

  /**
   * Responsibility determination may be held by a direct production manager,
   * a direct owner, or an order-scoped delegated grantee. Resolve the exact
   * existing authority fact rather than forcing all handlers into one role.
   */
  async actionableForResponsibilityHandler(
    client: PoolClient,
    actor: TrustedActorContext,
    projection: ResponsibilityHandlerProjection,
  ): Promise<void> {
    const direct = await client.query<{ role_code: string }>(
      `SELECT assignment.role_code
       FROM user_role_assignments assignment
       WHERE assignment.user_id=$1
         AND assignment.role_code=ANY(ARRAY['production_management','owner_group'])
         AND assignment.revoked_at IS NULL
         AND todo_user_has_direct_role(
           assignment.user_id,assignment.role_code,'responsibility:determine'
         )
       ORDER BY assignment.role_code
       LIMIT 2`,
      [projection.recipientUserId],
    );
    if (direct.rows.length === 1) {
      await this.actionableForRecipient(client, actor, {
        ...projection,
        requiredRole: direct.rows[0]!.role_code,
        requiredCapability: "responsibility:determine",
        policyKey: "general",
      });
      return;
    }
    if (direct.rows.length > 1) {
      throw new ApplicationError(
        "CONFLICT",
        "Responsibility handler has multiple direct roles; a single todo authority fact is required",
        409,
      );
    }
    const delegation = await client.query<{
      delegation_id: string;
      grantor_role: string;
    }>(
      `SELECT delegation.delegation_id,grantor_assignment.role_code grantor_role
       FROM delegated_authorizations delegation
       JOIN app_users grantee
         ON grantee.id=delegation.grantee_user_id AND grantee.enabled=true
       JOIN identity_mappings grantee_identity
         ON grantee_identity.user_id=grantee.id
        AND grantee_identity.provider='dingtalk'
        AND grantee_identity.active=true
        AND grantee_identity.employed=true
       JOIN access_security_policy grantee_policy
         ON grantee_policy.policy_key='primary'
        AND grantee_policy.dingtalk_corp_id=grantee_identity.corp_id
       JOIN user_role_assignments grantor_assignment
         ON grantor_assignment.user_id=delegation.grantor_user_id
        AND grantor_assignment.role_code=ANY(ARRAY['production_management','owner_group'])
        AND grantor_assignment.revoked_at IS NULL
       WHERE delegation.grantee_user_id=$1
         AND delegation.capability='responsibility:determine'
         AND delegation.scope_type='rework_order'
         AND delegation.scope_id=$2
         AND delegation.revoked_at IS NULL
         AND CURRENT_TIMESTAMP BETWEEN delegation.valid_from AND delegation.valid_until
         AND todo_user_has_direct_role(
           delegation.grantor_user_id,grantor_assignment.role_code,'responsibility:determine'
         )
       ORDER BY delegation.delegation_id
       LIMIT 2`,
      [projection.recipientUserId, projection.entityId],
    );
    if (delegation.rows.length !== 1) {
      throw new ApplicationError(
        "CONFLICT",
        "Responsibility handler is not uniquely routable from an active direct role or order delegation",
        409,
      );
    }
    await this.actionableForRecipient(client, actor, {
      ...projection,
      requiredRole: delegation.rows[0]!.grantor_role,
      requiredCapability: "responsibility:determine",
      delegationId: delegation.rows[0]!.delegation_id,
      delegationScopeId: projection.entityId,
      policyKey: "general",
    });
  }

  /**
   * Finance actions may be performed by a direct role holder or a verified
   * order-scoped delegation. Both paths must resolve to exactly one person;
   * the delegated authority is recorded on the todo rather than inferred when
   * it is later actioned or transferred.
   */
  async actionableForUniqueRoleOrOrderDelegate(
    client: PoolClient,
    actor: TrustedActorContext,
    projection: ActionableProjection,
  ): Promise<void> {
    const direct = await client.query<{ user_id: string }>(
      `SELECT DISTINCT assignment.user_id
       FROM user_role_assignments assignment
       WHERE assignment.role_code=$1 AND assignment.revoked_at IS NULL
         AND todo_user_has_direct_role(assignment.user_id,$1,$2)
       ORDER BY assignment.user_id
       LIMIT 2`,
      [projection.requiredRole, projection.requiredCapability],
    );
    if (direct.rows.length === 1) {
      await this.actionableForRecipient(client, actor, {
        ...projection,
        recipientUserId: direct.rows[0]!.user_id,
      });
      return;
    }
    if (direct.rows.length > 1) {
      throw new ApplicationError(
        "CONFLICT",
        "Finance todo has multiple direct recipients; it cannot silently broadcast an actionable task",
        409,
      );
    }
    const delegated = await client.query<{
      grantee_user_id: string;
      delegation_id: string;
    }>(
      `SELECT delegation.grantee_user_id,delegation.delegation_id
       FROM delegated_authorizations delegation
       JOIN app_users grantee
         ON grantee.id=delegation.grantee_user_id AND grantee.enabled=true
       JOIN identity_mappings grantee_identity
         ON grantee_identity.user_id=grantee.id
        AND grantee_identity.provider='dingtalk'
        AND grantee_identity.active=true
        AND grantee_identity.employed=true
       JOIN access_security_policy grantee_policy
         ON grantee_policy.policy_key='primary'
        AND grantee_policy.dingtalk_corp_id=grantee_identity.corp_id
       JOIN user_role_assignments grantor_assignment
         ON grantor_assignment.user_id=delegation.grantor_user_id
        AND grantor_assignment.role_code=$1
        AND grantor_assignment.revoked_at IS NULL
       WHERE delegation.capability=$2
         AND delegation.scope_type='rework_order'
         AND delegation.scope_id=$3
         AND delegation.revoked_at IS NULL
         AND CURRENT_TIMESTAMP BETWEEN delegation.valid_from AND delegation.valid_until
         AND todo_user_has_direct_role(
           delegation.grantor_user_id,$1,$2
         )
       ORDER BY delegation.delegation_id
       LIMIT 2`,
      [
        projection.requiredRole,
        projection.requiredCapability,
        projection.delegationScopeId ?? projection.entityId,
      ],
    );
    if (delegated.rows.length !== 1) {
      throw new ApplicationError(
        "CONFLICT",
        "Finance todo recipient is not uniquely routable from a direct role or verified order delegation",
        409,
      );
    }
    await this.actionableForRecipient(client, actor, {
      ...projection,
      recipientUserId: delegated.rows[0]!.grantee_user_id,
      delegationId: delegated.rows[0]!.delegation_id,
      delegationScopeId: projection.delegationScopeId ?? projection.entityId,
    });
  }

  /**
   * A rejection must return to the original actor under the authority that
   * created the source fact. Re-reading the immutable operation-event snapshot
   * avoids inferring a role from a display name or today's UI assignment.
   */
  async actionableForNamedSourceActor(
    client: PoolClient,
    actor: TrustedActorContext,
    projection: NamedSourceActorProjection,
  ): Promise<void> {
    const source = await client.query<{
      actor_id: string;
      actor_roles: string[];
      authorization_capability: string;
    }>(
      `SELECT actor_id,actor_roles,authorization_capability
       FROM operation_events
       WHERE event_id=$1
       FOR KEY SHARE`,
      [projection.sourceActorEventId],
    );
    const sourceRow = source.rows[0];
    if (
      !sourceRow
      || sourceRow.actor_id !== projection.recipientUserId
      || !projection.permittedCapabilities.includes(sourceRow.authorization_capability)
    ) {
      throw new ApplicationError(
        "CONFLICT",
        "The original actionable actor cannot be verified from the source operation event",
        409,
      );
    }
    const roles = await client.query<{ role_code: string }>(
      `SELECT DISTINCT role_code
       FROM role_capabilities
       WHERE role_code=ANY($1::text[])
         AND capability=$2
       ORDER BY role_code
       LIMIT 2`,
      [sourceRow.actor_roles, sourceRow.authorization_capability],
    );
    if (roles.rows.length !== 1) {
      throw new ApplicationError(
        "CONFLICT",
        "The source operation event does not identify one actionable business role",
        409,
      );
    }
    await this.actionableForNamedRecipient(client, actor, {
      category: projection.category,
      sourceEventId: projection.sourceEventId,
      sourceAction: projection.sourceAction,
      entityType: projection.entityType,
      entityId: projection.entityId,
      recipientUserId: projection.recipientUserId,
      requiredRole: roles.rows[0]!.role_code,
      requiredCapability: sourceRow.authorization_capability,
      route: projection.route,
      policyKey: projection.policyKey,
      dedupeKey: projection.dedupeKey,
    });
  }
}
