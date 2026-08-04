import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import {
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";
import { TodoProjectionService } from "./projection-service.js";
import { TodoService, type TodoRouteTemplate } from "./service.js";

type Mode = "dry_run" | "apply";
type PolicyKey = "general" | "finance_return_or_wage_review" | "deduction_follow_up";
type CandidateKind =
  | "process_configuration"
  | "ie_review"
  | "process_configuration_return"
  | "whole_order_review"
  | "work_report_return"
  | "responsibility_determination"
  | "high_multiplier_confirmation"
  | "own_factory_approval"
  | "external_business_signoff"
  | "external_payables_confirmation"
  | "external_payables_return"
  | "external_deduction_follow_up"
  | "external_deduction_overdue"
  | "wage_tail_review"
  | "wage_administrative_review"
  | "wage_month_close"
  | "wage_adjustment_approval";

type Watermark = Readonly<{ createdAt: string; eventId: string }>;
type Cursor = Readonly<{ lastKey: string }>;

type Candidate = Readonly<{
  kind: CandidateKind;
  cursorKey: string;
  sourceEventId: string | null;
  sourceAction: string;
  entityType: string;
  entityId: string;
  category: string;
  route: TodoRouteTemplate;
  policyKey: PolicyKey;
  dedupeKey: string;
  requiredRole: string;
  requiredCapability: string;
  recipientUserId?: string;
  sourceActorEventId?: string;
  excludeUserId?: string;
  delegationScopeId?: string;
  authoritativeDueAt?: Date;
  expectedRecipientCount?: number;
  highMultiplierAuthorIsOwner?: boolean;
}>;

type Counters = {
  scanned: number;
  eligible: number;
  existing: number;
  recipientBlocked: number;
  missingSourceEvent: number;
  inapplicableState: number;
  ambiguousRecipient: number;
  created: number;
};

type StoredRun = Readonly<{
  run_id: string;
  event_high_watermark: Watermark;
  cursor: Cursor | null;
  counters: Partial<Counters> | null;
}>;

export type TodoBackfillResult = Readonly<{
  runId: string | null;
  mode: Mode;
  startedAt: string;
  finishedAt: string;
  highWatermark: Watermark;
  cursor: Cursor | null;
  counters: Counters;
}>;

export type RunTodoBackfillInput = Readonly<{
  mode: Mode;
  actorUserId?: string;
  batchSize?: number;
  resumeRunId?: string;
}>;

const emptyCounters = (): Counters => ({
  scanned: 0,
  eligible: 0,
  existing: 0,
  recipientBlocked: 0,
  missingSourceEvent: 0,
  inapplicableState: 0,
  ambiguousRecipient: 0,
  created: 0,
});

const mergeCounters = (target: Counters, source: Counters): void => {
  for (const key of Object.keys(target) as Array<keyof Counters>) target[key] += source[key];
};

const countersFromRecord = (stored: Partial<Counters> | null | undefined): Counters => {
  const counters = emptyCounters();
  for (const key of Object.keys(counters) as Array<keyof Counters>) {
    const value = stored?.[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) counters[key] = value;
  }
  return counters;
};

const watermarkPredicate = (alias: string, startAt: number, eventAt: number): string =>
  `(${alias}.created_at < $${startAt} OR (${alias}.created_at = $${startAt} AND ${alias}.event_id::text <= $${eventAt}))`;

const isApplicationError = (error: unknown): error is ApplicationError =>
  error instanceof ApplicationError;

/**
 * A deliberately finite, state-based historical projector. It does not replay
 * arbitrary operation events: each candidate first proves that a formal record
 * is still pending, then resolves the latest event that caused that state at
 * the run high-watermark. The regular TodoService still owns dedupe, recipient
 * validity, immutable audit facts and outbox enqueueing.
 */
export class TodoBackfillService {
  private readonly todos: TodoService;
  private readonly projections: TodoProjectionService;
  private readonly events = new OperationEventRepository();

  constructor(private readonly database: Pool) {
    this.todos = new TodoService(database);
    this.projections = new TodoProjectionService(this.todos);
  }

  async run(input: RunTodoBackfillInput): Promise<TodoBackfillResult> {
    const batchSize = input.batchSize ?? 100;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
      throw new ApplicationError("VALIDATION_ERROR", "Backfill batch size must be between 1 and 500", 400);
    }
    if (input.mode === "dry_run" && input.resumeRunId) {
      throw new ApplicationError("VALIDATION_ERROR", "Dry-run cannot resume a persisted backfill run", 400);
    }
    if (input.mode === "apply" && !input.actorUserId) {
      throw new ApplicationError("VALIDATION_ERROR", "--actor-user-id is required for --apply", 400);
    }

    const startedAt = new Date().toISOString();
    let runId: string | null = null;
    let cursor: Cursor | null = null;
    let watermark: Watermark;
    let actor: TrustedActorContext | null = null;
    let counters = emptyCounters();

    if (input.mode === "apply" && input.resumeRunId) {
      const stored = await this.resumeRun(input.resumeRunId);
      runId = stored.run_id;
      watermark = stored.event_high_watermark;
      cursor = stored.cursor;
      actor = await this.resolveActor(input.actorUserId!);
      counters = countersFromRecord(stored.counters);
      await this.recordResume(runId, watermark, actor);
    } else {
      watermark = await this.captureWatermark();
      if (input.mode === "apply") {
        actor = await this.resolveActor(input.actorUserId!);
        runId = randomUUID();
        await this.createRun(runId, watermark, actor);
      }
    }

    const candidates = await this.collectCandidates(watermark);
    const remaining = candidates.filter((candidate) => !cursor || candidate.cursorKey > cursor.lastKey);

    try {
      for (let offset = 0; offset < remaining.length; offset += batchSize) {
        const batch = remaining.slice(offset, offset + batchSize);
        const batchCounters = emptyCounters();
        for (const candidate of batch) {
          const result = await this.processCandidate(candidate, actor, input.mode, runId);
          mergeCounters(batchCounters, result);
        }
        mergeCounters(counters, batchCounters);
        cursor = batch.length > 0 ? { lastKey: batch[batch.length - 1]!.cursorKey } : cursor;
        if (input.mode === "apply" && runId) {
          await this.persistProgress(runId, cursor, counters);
        }
      }
      if (input.mode === "apply" && runId) {
        await this.completeRun(runId, cursor, counters);
      }
    } catch (error: unknown) {
      if (input.mode === "apply" && runId) {
        await this.failRun(runId, cursor, counters, error);
      }
      throw error;
    }

    return {
      runId,
      mode: input.mode,
      startedAt,
      finishedAt: new Date().toISOString(),
      highWatermark: watermark,
      cursor,
      counters,
    };
  }

  private async processCandidate(
    candidate: Candidate,
    actor: TrustedActorContext | null,
    mode: Mode,
    runId: string | null,
  ): Promise<Counters> {
    const counters = emptyCounters();
    counters.scanned = 1;
    if (!candidate.sourceEventId) {
      counters.missingSourceEvent = 1;
      if (mode === "apply" && runId) {
        await this.recordException(runId, candidate, null, "skipped_missing_source_event", {
          expectedAction: candidate.sourceAction,
        });
      }
      return counters;
    }

    const client = await this.database.connect();
    let blockedRecipient = false;
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ todo_id: string }>(
        "SELECT todo_id FROM rework_todos WHERE dedupe_key=$1 FOR KEY SHARE",
        [candidate.dedupeKey],
      );
      if (existing.rowCount) {
        counters.existing = 1;
      } else if (!actor) {
        // Dry-run validates actual projections in a transaction, but needs no
        // persisted production-management actor. A source event snapshot is a
        // complete audit actor for this rollback-only simulation.
        const simulated = await this.sourceActor(client, candidate.sourceEventId, `todo-backfill-dry-${randomUUID()}`);
        await this.project(client, simulated, candidate);
        counters.eligible = 1;
        counters.created = 1;
        const created = await client.query<{ status: string }>(
          "SELECT status FROM rework_todos WHERE dedupe_key=$1 FOR KEY SHARE",
          [candidate.dedupeKey],
        );
        blockedRecipient = created.rows[0]?.status === "blocked_recipient";
      } else {
        await this.project(client, actor, candidate);
        counters.eligible = 1;
        const created = await client.query<{ status: string }>(
          "SELECT status FROM rework_todos WHERE dedupe_key=$1 FOR KEY SHARE",
          [candidate.dedupeKey],
        );
        counters.created = 1;
        blockedRecipient = created.rows[0]?.status === "blocked_recipient";
      }
      if (mode === "dry_run") await client.query("ROLLBACK");
      else await client.query("COMMIT");
      if (blockedRecipient) {
        counters.recipientBlocked = 1;
        if (mode === "apply" && runId) {
          await this.recordException(runId, candidate, candidate.sourceEventId, "skipped_recipient_inactive", {
            outcome: "blocked_recipient_with_routing_exception",
          });
        }
      }
      return counters;
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      if (isApplicationError(error) && error.code === "CONFLICT") {
        counters.ambiguousRecipient = 1;
        if (mode === "apply" && runId) {
          await this.recordException(runId, candidate, candidate.sourceEventId, "skipped_ambiguous_recipient", {
            message: error.message,
          });
        }
        return counters;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async project(
    client: PoolClient,
    actor: TrustedActorContext,
    candidate: Candidate,
  ): Promise<void> {
    const projection = {
      category: candidate.category,
      sourceEventId: candidate.sourceEventId!,
      sourceAction: candidate.sourceAction,
      entityType: candidate.entityType,
      entityId: candidate.entityId,
      requiredRole: candidate.requiredRole,
      requiredCapability: candidate.requiredCapability,
      route: candidate.route,
      policyKey: candidate.policyKey,
      dedupeKey: candidate.dedupeKey,
      ...(candidate.delegationScopeId ? { delegationScopeId: candidate.delegationScopeId } : {}),
      ...(candidate.authoritativeDueAt ? { authoritativeDueAt: candidate.authoritativeDueAt } : {}),
    } as const;

    switch (candidate.kind) {
      case "process_configuration":
      case "ie_review":
      case "whole_order_review":
      case "wage_tail_review":
      case "wage_administrative_review":
      case "wage_month_close":
        await this.projections.actionableForUniqueDirectRole(client, actor, projection);
        return;
      case "process_configuration_return":
        await this.projections.actionableForNamedRecipient(client, actor, {
          ...projection,
          recipientUserId: candidate.recipientUserId!,
        });
        return;
      case "work_report_return":
      case "external_business_signoff":
      case "external_payables_return":
        await this.projections.actionableForNamedSourceActor(client, actor, {
          ...projection,
          policyKey: candidate.policyKey === "deduction_follow_up" ? "general" : candidate.policyKey,
          recipientUserId: candidate.recipientUserId!,
          sourceActorEventId: candidate.sourceActorEventId!,
          permittedCapabilities: candidate.kind === "work_report_return"
            ? ["work:report", "work:report_for_worker"]
            : ["external_responsibility:sign"],
        });
        return;
      case "responsibility_determination":
        await this.projections.actionableForResponsibilityHandler(client, actor, {
          category: candidate.category,
          sourceEventId: candidate.sourceEventId!,
          sourceAction: candidate.sourceAction,
          entityType: candidate.entityType,
          entityId: candidate.entityId,
          recipientUserId: candidate.recipientUserId!,
          route: candidate.route,
          dedupeKey: candidate.dedupeKey,
        });
        return;
      case "high_multiplier_confirmation":
        if (candidate.highMultiplierAuthorIsOwner) {
          await this.projections.actionableForIndependentOwner(client, actor, {
            ...projection,
            dedupeKey: `${candidate.dedupeKey}:${candidate.excludeUserId!}`,
            excludeUserId: candidate.excludeUserId!,
          });
        } else {
          await this.projections.actionableForParallelDirectRole(client, actor, {
            ...projection,
            expectedRecipientCount: candidate.expectedRecipientCount ?? 2,
          });
        }
        return;
      case "own_factory_approval":
        await this.projections.actionableForParallelDirectRole(client, actor, {
          ...projection,
          expectedRecipientCount: candidate.expectedRecipientCount ?? 2,
        });
        return;
      case "external_payables_confirmation":
      case "external_deduction_follow_up":
      case "external_deduction_overdue":
        await this.projections.actionableForUniqueRoleOrOrderDelegate(client, actor, projection);
        return;
      case "wage_adjustment_approval":
        await this.projections.actionableForUniqueDirectRoleExcluding(client, actor, {
          ...projection,
          excludeUserId: candidate.excludeUserId!,
        });
        return;
    }
  }

  private async collectCandidates(watermark: Watermark): Promise<Candidate[]> {
    const candidates = await Promise.all([
      this.pendingProcessConfiguration(watermark),
      this.pendingIeReview(watermark),
      this.rejectedProcessConfiguration(watermark),
      this.pendingWholeOrderReview(watermark),
      this.pendingWorkReportReturns(watermark),
      this.pendingResponsibility(watermark),
      this.pendingOwnFactoryApprovals(watermark),
      this.pendingExternalCases(watermark),
      this.pendingWages(watermark),
    ]);
    return candidates.flat().sort((left, right) => left.cursorKey.localeCompare(right.cursorKey));
  }

  private async pendingProcessConfiguration(watermark: Watermark): Promise<Candidate[]> {
    const result = await this.database.query<{
      rework_order_id: string; version: number; source_event_id: string | null;
    }>(
      `SELECT order_record.rework_order_id,order_record.version,source.event_id source_event_id
       FROM rework_orders order_record
       LEFT JOIN LATERAL (
         SELECT event_id FROM operation_events event
         WHERE event.action='rework.submit' AND event.entity_type='rework_order'
           AND event.entity_id=order_record.rework_order_id::text
           AND event.after_state @> jsonb_build_object('status','pending_process_configuration')
           AND ${watermarkPredicate("event", 1, 2)}
         ORDER BY event.created_at DESC,event.event_id DESC LIMIT 1
       ) source ON true
       WHERE order_record.status='pending_process_configuration'
       ORDER BY order_record.rework_order_id`,
      [watermark.createdAt, watermark.eventId],
    );
    return result.rows.map((row) => this.candidate({
      kind: "process_configuration", id: row.rework_order_id, sourceEventId: row.source_event_id,
      sourceAction: "rework.submit", entityType: "rework_order", entityId: row.rework_order_id,
      category: "process_configuration", route: { routeName: "process_configuration", entityId: row.rework_order_id },
      policyKey: "general", requiredRole: "tail_supervisor", requiredCapability: "process:configure",
      dedupeKey: `process-config:${row.rework_order_id}:${row.version}`,
    }));
  }

  private async pendingIeReview(watermark: Watermark): Promise<Candidate[]> {
    const result = await this.database.query<{
      rework_order_id: string; configuration_id: string; configuration_version: number; source_event_id: string | null;
    }>(
      `SELECT order_record.rework_order_id,configuration.configuration_id,configuration.configuration_version,
              source.event_id source_event_id
       FROM rework_orders order_record
       JOIN rework_process_configurations configuration
         ON configuration.rework_order_id=order_record.rework_order_id
        AND configuration.status='pending_ie_review'
       LEFT JOIN LATERAL (
         SELECT event_id FROM operation_events event
         WHERE event.action='rework.process_configuration.submit' AND event.entity_type='rework_order'
           AND event.entity_id=order_record.rework_order_id::text
           AND event.after_state @> jsonb_build_object(
             'status','pending_ie_review',
             'configuration',jsonb_build_object('configurationId',configuration.configuration_id,'status','pending_ie_review')
           )
           AND ${watermarkPredicate("event", 1, 2)}
         ORDER BY event.created_at DESC,event.event_id DESC LIMIT 1
       ) source ON true
       WHERE order_record.status='pending_ie_review'
       ORDER BY order_record.rework_order_id,configuration.configuration_id`,
      [watermark.createdAt, watermark.eventId],
    );
    return result.rows.map((row) => this.candidate({
      kind: "ie_review", id: row.configuration_id, sourceEventId: row.source_event_id,
      sourceAction: "rework.process_configuration.submit", entityType: "rework_order", entityId: row.rework_order_id,
      category: "ie_review", route: { routeName: "process_configuration", entityId: row.rework_order_id },
      policyKey: "general", requiredRole: "ie_reviewer", requiredCapability: "process:review",
      dedupeKey: `ie-review:${row.rework_order_id}:${row.configuration_version}`,
    }));
  }

  private async rejectedProcessConfiguration(watermark: Watermark): Promise<Candidate[]> {
    const result = await this.database.query<{
      rework_order_id: string; configuration_id: string; configuration_version: number; created_by: string; source_event_id: string | null;
    }>(
      `SELECT order_record.rework_order_id,configuration.configuration_id,configuration.configuration_version,
              configuration.created_by,source.event_id source_event_id
       FROM rework_orders order_record
       JOIN LATERAL (
         SELECT * FROM rework_process_configurations configuration
         WHERE configuration.rework_order_id=order_record.rework_order_id
         ORDER BY configuration.configuration_version DESC LIMIT 1
       ) configuration ON configuration.status='rejected'
       LEFT JOIN LATERAL (
         SELECT event_id FROM operation_events event
         WHERE event.action='rework.process_configuration.review' AND event.entity_type='rework_order'
           AND event.entity_id=order_record.rework_order_id::text
           AND event.after_state @> jsonb_build_object(
             'status','pending_process_configuration',
             'configuration',jsonb_build_object('configurationId',configuration.configuration_id,'status','rejected')
           )
           AND ${watermarkPredicate("event", 1, 2)}
         ORDER BY event.created_at DESC,event.event_id DESC LIMIT 1
       ) source ON true
       WHERE order_record.status='pending_process_configuration'
       ORDER BY order_record.rework_order_id`,
      [watermark.createdAt, watermark.eventId],
    );
    return result.rows.map((row) => this.candidate({
      kind: "process_configuration_return", id: row.configuration_id, sourceEventId: row.source_event_id,
      sourceAction: "rework.process_configuration.review", entityType: "rework_order", entityId: row.rework_order_id,
      category: "process_configuration_return", route: { routeName: "process_configuration", entityId: row.rework_order_id },
      policyKey: "general", requiredRole: "tail_supervisor", requiredCapability: "process:configure",
      recipientUserId: row.created_by,
      dedupeKey: `process-config-return:${row.configuration_id}:${row.configuration_version}`,
    }));
  }

  private async pendingWholeOrderReview(watermark: Watermark): Promise<Candidate[]> {
    const result = await this.database.query<{
      rework_order_id: string; version: number; source_event_id: string | null;
    }>(
      `SELECT order_record.rework_order_id,order_record.version,source.event_id source_event_id
       FROM rework_orders order_record
       LEFT JOIN LATERAL (
         SELECT event_id FROM operation_events event
         WHERE event.action='rework.work_report.submit' AND event.entity_type='rework_order'
           AND event.entity_id=order_record.rework_order_id::text
           AND event.after_state @> jsonb_build_object('status','pending_order_review')
           AND ${watermarkPredicate("event", 1, 2)}
         ORDER BY event.created_at DESC,event.event_id DESC LIMIT 1
       ) source ON true
       WHERE order_record.status='pending_order_review'
       ORDER BY order_record.rework_order_id`,
      [watermark.createdAt, watermark.eventId],
    );
    return result.rows.map((row) => this.candidate({
      kind: "whole_order_review", id: row.rework_order_id, sourceEventId: row.source_event_id,
      sourceAction: "rework.work_report.submit", entityType: "rework_order", entityId: row.rework_order_id,
      category: "whole_order_review", route: { routeName: "rework_detail", entityId: row.rework_order_id, tab: "whole_order_review" },
      policyKey: "general", requiredRole: "tail_supervisor", requiredCapability: "submission:audit",
      dedupeKey: `whole-order-review:${row.rework_order_id}:${row.version}`,
    }));
  }

  private async pendingWorkReportReturns(watermark: Watermark): Promise<Candidate[]> {
    const result = await this.database.query<{
      work_report_id: string; rework_order_id: string; submitted_by: string;
      source_event_id: string | null; submission_event_id: string | null;
    }>(
      `SELECT rejection.work_report_id,rejection.rework_order_id,report.submitted_by,
              CASE WHEN submission_event.event_id IS NULL THEN NULL ELSE rejection_event.event_id END source_event_id,
              submission_event.event_id submission_event_id
       FROM rework_work_report_rejections rejection
       JOIN rework_work_reports report ON report.work_report_id=rejection.work_report_id
       LEFT JOIN LATERAL (
         SELECT event_id FROM operation_events event
         WHERE event.action='rework.work_report.reject' AND event.entity_type='rework_order'
           AND event.entity_id=rejection.rework_order_id::text
           AND event.after_state->>'workReportId'=rejection.work_report_id::text
           AND ${watermarkPredicate("event", 1, 2)}
         ORDER BY event.created_at DESC,event.event_id DESC LIMIT 1
       ) rejection_event ON true
       LEFT JOIN LATERAL (
         SELECT event_id FROM operation_events event
         WHERE event.action='rework.work_report.submit'
           AND event.after_state->>'workReportId'=rejection.work_report_id::text
           AND ${watermarkPredicate("event", 1, 2)}
         ORDER BY event.created_at DESC,event.event_id DESC LIMIT 1
       ) submission_event ON true
       WHERE NOT EXISTS (
         SELECT 1 FROM rework_work_reports resubmission
         WHERE resubmission.resubmits_work_report_id=rejection.work_report_id
       )
       ORDER BY rejection.work_report_id`,
      [watermark.createdAt, watermark.eventId],
    );
    return result.rows.map((row) => this.candidate({
      kind: "work_report_return", id: row.work_report_id, sourceEventId: row.source_event_id,
      sourceAction: "rework.work_report.reject", entityType: "rework_order", entityId: row.rework_order_id,
      category: "work_report_return", route: { routeName: "rework_detail", entityId: row.rework_order_id, tab: "whole_order_review" },
      policyKey: "general", requiredRole: "work_report_submitter", requiredCapability: "work:report",
      recipientUserId: row.submitted_by,
      ...(row.submission_event_id ? { sourceActorEventId: row.submission_event_id } : {}),
      dedupeKey: `work-report-return:${row.work_report_id}`,
    }));
  }

  private async pendingResponsibility(watermark: Watermark): Promise<Candidate[]> {
    const result = await this.database.query<{
      determination_id: string; rework_order_id: string; determination_version: number; handler_user_id: string;
      created_by: string; source_event_id: string | null; actor_roles: string[] | null; has_high_multiplier: boolean;
    }>(
      `SELECT determination.determination_id,determination.rework_order_id,determination.determination_version,
              COALESCE(handler_event.to_user_id,determination.handler_user_id) handler_user_id,
              determination.created_by,source.event_id source_event_id,source.actor_roles,
              EXISTS(
                SELECT 1 FROM rework_responsibility_processes process
                WHERE process.determination_id=determination.determination_id AND process.multiplier>2
              ) has_high_multiplier
       FROM rework_responsibility_determinations determination
       JOIN rework_orders order_record ON order_record.rework_order_id=determination.rework_order_id
       LEFT JOIN LATERAL (
         SELECT handler.to_user_id FROM rework_responsibility_handler_events handler
         WHERE handler.determination_id=determination.determination_id
         ORDER BY handler.created_at DESC,handler.handler_event_id DESC LIMIT 1
       ) handler_event ON true
       LEFT JOIN LATERAL (
         SELECT event_id,actor_roles FROM operation_events event
         WHERE event.event_id=determination.operation_event_id
           AND event.action='rework.responsibility.draft'
           AND ${watermarkPredicate("event", 1, 2)}
       ) source ON true
       WHERE determination.stage='draft'
         AND order_record.status IN ('pending_responsibility_determination','pending_responsibility_action')
         AND NOT EXISTS (
           SELECT 1 FROM rework_responsibility_determinations successor
           WHERE successor.replaces_determination_id=determination.determination_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM rework_responsibility_high_multiplier_confirmations confirmation
           WHERE confirmation.determination_id=determination.determination_id
         )
       ORDER BY determination.determination_id`,
      [watermark.createdAt, watermark.eventId],
    );
    return result.rows.flatMap((row) => {
      const base = this.candidate({
        kind: "responsibility_determination", id: row.determination_id, sourceEventId: row.source_event_id,
        sourceAction: "rework.responsibility.draft", entityType: "rework_order", entityId: row.rework_order_id,
        category: "responsibility_determination", route: { routeName: "responsibility_detail", entityId: row.rework_order_id },
        policyKey: "general", requiredRole: "responsibility_handler", requiredCapability: "responsibility:determine",
        recipientUserId: row.handler_user_id,
        dedupeKey: `responsibility:${row.rework_order_id}:${row.determination_version}`,
      });
      if (!row.has_high_multiplier) return [base];
      return [
        base,
        this.candidate({
          kind: "high_multiplier_confirmation", id: `${row.determination_id}:high`, sourceEventId: row.source_event_id,
          sourceAction: "rework.responsibility.draft", entityType: "rework_order", entityId: row.rework_order_id,
          category: "high_multiplier_confirmation", route: { routeName: "responsibility_detail", entityId: row.rework_order_id },
          policyKey: "general", requiredRole: "owner_group", requiredCapability: "responsibility:confirm_high_multiplier",
          highMultiplierAuthorIsOwner: row.actor_roles?.includes("owner_group") ?? false,
          excludeUserId: row.created_by, expectedRecipientCount: 2,
          dedupeKey: `high-multiplier:${row.determination_id}:${row.determination_version}`,
        }),
      ];
    });
  }

  private async pendingOwnFactoryApprovals(watermark: Watermark): Promise<Candidate[]> {
    const result = await this.database.query<{
      approval_id: string; rework_order_id: string; source_event_id: string | null;
    }>(
      `SELECT approval.approval_id,approval.rework_order_id,source.event_id source_event_id
       FROM rework_own_factory_approvals approval
       LEFT JOIN LATERAL (
         SELECT event_id FROM operation_events event
         WHERE event.event_id=approval.created_operation_event_id
           AND event.action='rework.own_factory_approval.create'
           AND ${watermarkPredicate("event", 1, 2)}
       ) source ON true
       WHERE approval.status='pending'
       ORDER BY approval.approval_id`,
      [watermark.createdAt, watermark.eventId],
    );
    return result.rows.map((row) => this.candidate({
      kind: "own_factory_approval", id: row.approval_id, sourceEventId: row.source_event_id,
      sourceAction: "rework.own_factory_approval.create", entityType: "rework_order", entityId: row.rework_order_id,
      category: "own_factory_approval", route: { routeName: "own_factory_approval", entityId: row.rework_order_id },
      policyKey: "general", requiredRole: "owner_group", requiredCapability: "own_factory:approve",
      expectedRecipientCount: 2, dedupeKey: `own-factory-approval:${row.approval_id}`,
    }));
  }

  private async pendingExternalCases(watermark: Watermark): Promise<Candidate[]> {
    const result = await this.database.query<{
      case_id: string; rework_order_id: string; status: string; case_version: number; business_handler_user_id: string;
      payables_handler_role_snapshot: string; allocation_event_id: string | null; allocation_actor_id: string | null;
      source_event_id: string | null; signoff_event_id: string | null; return_event_id: string | null;
      accept_event_id: string | null; follow_up_event_id: string | null; next_follow_up_at: Date | null;
    }>(
      `SELECT target_case.case_id,target_case.rework_order_id,target_case.status,target_case.case_version,
              target_case.business_handler_user_id,target_case.payables_handler_role_snapshot,
              allocation_event.event_id allocation_event_id,allocation_event.actor_id allocation_actor_id,
              allocation_event.event_id source_event_id,signoff.operation_event_id signoff_event_id,
              payables_return.operation_event_id return_event_id,payables_accept.operation_event_id accept_event_id,
              follow_up.operation_event_id follow_up_event_id,follow_up.next_follow_up_at
       FROM rework_external_responsibility_cases target_case
       JOIN rework_external_responsibility_batches batch
         ON batch.batch_id=target_case.batch_id AND batch.status='active'
       LEFT JOIN LATERAL (
         SELECT event_id,actor_id FROM operation_events event
         WHERE event.event_id=target_case.operation_event_id
           AND event.action='rework.external_responsibility.allocate'
           AND ${watermarkPredicate("event", 1, 2)}
       ) allocation_event ON true
       LEFT JOIN LATERAL (
         SELECT operation_event_id FROM rework_external_business_signoffs signoff
         JOIN operation_events event ON event.event_id=signoff.operation_event_id
         WHERE signoff.case_id=target_case.case_id AND ${watermarkPredicate("event", 1, 2)}
         ORDER BY signoff.created_at DESC,signoff.signoff_id DESC LIMIT 1
       ) signoff ON true
       LEFT JOIN LATERAL (
         SELECT operation_event_id FROM rework_external_payables_actions action
         JOIN operation_events event ON event.event_id=action.operation_event_id
         WHERE action.case_id=target_case.case_id AND action.action='returned'
           AND ${watermarkPredicate("event", 1, 2)}
         ORDER BY action.created_at DESC,action.payables_action_id DESC LIMIT 1
       ) payables_return ON true
       LEFT JOIN LATERAL (
         SELECT operation_event_id FROM rework_external_payables_actions action
         JOIN operation_events event ON event.event_id=action.operation_event_id
         WHERE action.case_id=target_case.case_id AND action.action='accepted'
           AND ${watermarkPredicate("event", 1, 2)}
         ORDER BY action.created_at DESC,action.payables_action_id DESC LIMIT 1
       ) payables_accept ON true
       LEFT JOIN LATERAL (
         SELECT follow.operation_event_id,follow.next_follow_up_at FROM rework_external_deduction_follow_ups follow
         JOIN operation_events event ON event.event_id=follow.operation_event_id
         WHERE follow.case_id=target_case.case_id AND ${watermarkPredicate("event", 1, 2)}
         ORDER BY follow.created_at DESC,follow.follow_up_id DESC LIMIT 1
       ) follow_up ON true
       ORDER BY target_case.case_id`,
      [watermark.createdAt, watermark.eventId],
    );
    return result.rows.flatMap((row) => this.externalCandidates(row));
  }

  private externalCandidates(row: {
    case_id: string; rework_order_id: string; status: string; case_version: number; business_handler_user_id: string;
    payables_handler_role_snapshot: string; allocation_event_id: string | null; allocation_actor_id: string | null;
    source_event_id: string | null; signoff_event_id: string | null; return_event_id: string | null;
    accept_event_id: string | null; follow_up_event_id: string | null; next_follow_up_at: Date | null;
  }): Candidate[] {
    const route = { routeName: "external_responsibility_detail", entityId: row.case_id } as const;
    const base = {
      entityType: "rework_order", entityId: row.rework_order_id, route, delegationScopeId: row.rework_order_id,
    } as const;
    if (row.status === "pending_business_signoff") {
      return [this.candidate({
        kind: "external_business_signoff", id: row.case_id, sourceEventId: row.allocation_event_id,
        sourceAction: "rework.external_responsibility.allocate", category: "external_business_signoff",
        requiredRole: "external_signoff", requiredCapability: "external_responsibility:sign",
        recipientUserId: row.business_handler_user_id,
        ...(row.allocation_event_id ? { sourceActorEventId: row.allocation_event_id } : {}),
        dedupeKey: `external-signoff:${row.case_id}:${row.case_version}`, policyKey: "general", ...base,
      })];
    }
    if (row.status === "pending_payables_confirmation") {
      return [this.candidate({
        kind: "external_payables_confirmation", id: row.case_id, sourceEventId: row.signoff_event_id,
        sourceAction: "rework.external_responsibility.submit", category: "external_payables_confirmation",
        requiredRole: row.payables_handler_role_snapshot, requiredCapability: "external_responsibility:payables_confirm",
        dedupeKey: `external-payables:${row.case_id}:${row.case_version}`, policyKey: "general", ...base,
      })];
    }
    if (row.status === "returned") {
      return [this.candidate({
        kind: "external_payables_return", id: row.case_id,
        sourceEventId: row.signoff_event_id ? row.return_event_id : null,
        sourceAction: "rework.external_responsibility.payables_return", category: "external_payables_return",
        requiredRole: "external_signoff", requiredCapability: "external_responsibility:sign",
        recipientUserId: row.business_handler_user_id,
        ...(row.signoff_event_id ? { sourceActorEventId: row.signoff_event_id } : {}),
        dedupeKey: `external-return:${row.case_id}:${row.case_version}`, policyKey: "general", ...base,
      })];
    }
    if (row.status !== "deduction_follow_up") return [];
    const followUp = this.candidate({
      kind: "external_deduction_follow_up", id: row.case_id, sourceEventId: row.accept_event_id,
      sourceAction: "rework.external_responsibility.payables_accept", category: "external_deduction_follow_up",
      requiredRole: row.payables_handler_role_snapshot, requiredCapability: "external_deduction:follow_up",
      dedupeKey: `deduction-follow-up:${row.case_id}:${row.case_version}`, policyKey: "general", ...base,
    });
    if (!row.next_follow_up_at || row.next_follow_up_at.getTime() > Date.now()) return [followUp];
    return [
      followUp,
      this.candidate({
        kind: "external_deduction_overdue", id: `${row.case_id}:overdue`, sourceEventId: row.follow_up_event_id,
        sourceAction: "rework.external_deduction.follow_up", category: "external_deduction_overdue",
        requiredRole: row.payables_handler_role_snapshot, requiredCapability: "external_deduction:follow_up",
        authoritativeDueAt: row.next_follow_up_at,
        dedupeKey: `deduction-overdue:${row.case_id}:${row.next_follow_up_at.toISOString()}`,
        policyKey: "deduction_follow_up", ...base,
      }),
    ];
  }

  private async pendingWages(watermark: Watermark): Promise<Candidate[]> {
    const result = await this.database.query<{
      period_id: string; period_version: number; status: string; created_event_id: string | null;
      created_source_action: string | null; created_entity_type: string | null; created_entity_id: string | null;
      tail_event_id: string | null; admin_event_id: string | null;
    }>(
      `SELECT period.period_id,period.period_version,period.status,
              source.event_id created_event_id,source.action created_source_action,
              source.entity_type created_entity_type,source.entity_id created_entity_id,
              tail_action.operation_event_id tail_event_id,
              admin_action.operation_event_id admin_event_id
       FROM rework_wage_periods period
       LEFT JOIN LATERAL (
         SELECT event_id,action,entity_type,entity_id FROM operation_events event
         WHERE event.event_id=period.created_operation_event_id
           AND ${watermarkPredicate("event", 1, 2)}
       ) source ON true
       LEFT JOIN LATERAL (
         SELECT action.operation_event_id FROM rework_wage_review_actions action
         JOIN operation_events event ON event.event_id=action.operation_event_id
         WHERE action.period_id=period.period_id AND action.stage='tail' AND action.decision='approved'
           AND ${watermarkPredicate("event", 1, 2)}
         ORDER BY action.acted_at DESC,action.review_action_id DESC LIMIT 1
       ) tail_action ON true
       LEFT JOIN LATERAL (
         SELECT action.operation_event_id FROM rework_wage_review_actions action
         JOIN operation_events event ON event.event_id=action.operation_event_id
         WHERE action.period_id=period.period_id AND action.stage='administrative' AND action.decision='approved'
           AND ${watermarkPredicate("event", 1, 2)}
         ORDER BY action.acted_at DESC,action.review_action_id DESC LIMIT 1
       ) admin_action ON true
       WHERE period.status IN ('pending_tail_review','pending_admin_review','ready_to_lock')
       ORDER BY period.period_id`,
      [watermark.createdAt, watermark.eventId],
    );
    const adjustments = await this.database.query<{
      adjustment_id: string; target_period_id: string; version: number; requested_by: string; source_event_id: string | null;
    }>(
      `SELECT adjustment.adjustment_id,adjustment.target_period_id,adjustment.version,adjustment.requested_by,
              source.event_id source_event_id
       FROM rework_wage_adjustments adjustment
       LEFT JOIN LATERAL (
         SELECT event_id FROM operation_events event
         WHERE event.event_id=adjustment.request_operation_event_id
           AND event.action='wage.adjustment.request'
           AND ${watermarkPredicate("event", 1, 2)}
       ) source ON true
       WHERE adjustment.status='pending'
       ORDER BY adjustment.adjustment_id`,
      [watermark.createdAt, watermark.eventId],
    );
    const periodCandidates = result.rows.map((row) => {
      if (row.status === "pending_tail_review") return this.candidate({
        kind: "wage_tail_review", id: row.period_id, sourceEventId: row.created_event_id,
        sourceAction: row.created_source_action ?? "rework.whole_order.approve",
        entityType: row.created_entity_type ?? "rework_order", entityId: row.created_entity_id ?? row.period_id,
        category: "wage_tail_review", route: { routeName: "wage_period_detail", entityId: row.period_id },
        policyKey: "finance_return_or_wage_review", requiredRole: "tail_supervisor", requiredCapability: "wage:tail_review",
        dedupeKey: `wage-tail-review:${row.period_id}:${row.period_version}`,
      });
      if (row.status === "pending_admin_review") return this.candidate({
        kind: "wage_administrative_review", id: row.period_id, sourceEventId: row.tail_event_id,
        sourceAction: "wage.tail_approve", entityType: "wage_period", entityId: row.period_id,
        category: "wage_administrative_review", route: { routeName: "wage_period_detail", entityId: row.period_id },
        policyKey: "finance_return_or_wage_review", requiredRole: "administrative_clerk", requiredCapability: "wage:administrative_review",
        dedupeKey: `wage-admin-review:${row.period_id}:${row.period_version}`,
      });
      return this.candidate({
        kind: "wage_month_close", id: row.period_id, sourceEventId: row.admin_event_id,
        sourceAction: "wage.administrative_approve", entityType: "wage_period", entityId: row.period_id,
        category: "wage_month_close", route: { routeName: "wage_period_detail", entityId: row.period_id },
        policyKey: "finance_return_or_wage_review", requiredRole: "wage_month_close_accountant", requiredCapability: "wage:month_close",
        dedupeKey: `wage-month-lock:${row.period_id}:${row.period_version}`,
      });
    });
    return [
      ...periodCandidates,
      ...adjustments.rows.map((row) => this.candidate({
        kind: "wage_adjustment_approval", id: row.adjustment_id, sourceEventId: row.source_event_id,
        sourceAction: "wage.adjustment.request", entityType: "wage_adjustment", entityId: row.adjustment_id,
        category: "wage_adjustment_approval", route: { routeName: "wage_period_detail", entityId: row.target_period_id },
        policyKey: "finance_return_or_wage_review", requiredRole: "administrative_clerk", requiredCapability: "wage:adjustment_approve",
        excludeUserId: row.requested_by, dedupeKey: `wage-adjustment:${row.adjustment_id}:${row.version}`,
      })),
    ];
  }

  private candidate(input: Omit<Candidate, "cursorKey"> & Readonly<{ id: string }>): Candidate {
    const { id, ...candidate } = input;
    return { ...candidate, cursorKey: `${candidate.kind}:${id}` };
  }

  private async captureWatermark(): Promise<Watermark> {
    const result = await this.database.query<{ created_at: Date; event_id: string }>(
      "SELECT created_at,event_id FROM operation_events ORDER BY created_at DESC,event_id DESC LIMIT 1",
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("CONFLICT", "Backfill requires an existing operation-event history", 409);
    return { createdAt: row.created_at.toISOString(), eventId: row.event_id };
  }

  private async resolveActor(actorUserId: string): Promise<TrustedActorContext> {
    const result = await this.database.query<{ role_code: string; capability: string }>(
      `SELECT assignment.role_code,capability.capability
       FROM user_role_assignments assignment
       JOIN role_capabilities capability ON capability.role_code=assignment.role_code
       WHERE assignment.user_id=$1 AND assignment.revoked_at IS NULL
       ORDER BY assignment.role_code,capability.capability`,
      [actorUserId],
    );
    const roles = [...new Set(result.rows.map((row) => row.role_code))];
    const capabilities = [...new Set(result.rows.map((row) => row.capability))];
    const allowed = await this.database.query<{ allowed: boolean }>(
      "SELECT todo_user_has_direct_role($1,'production_management','todo:routing_exception_manage') allowed",
      [actorUserId],
    );
    if (!allowed.rows[0]?.allowed) {
      throw new ApplicationError("FORBIDDEN", "Backfill actor must be a direct active production-management user", 403);
    }
    return {
      actorId: actorUserId,
      actorRoles: roles,
      authorizationCapability: "todo:routing_exception_manage",
      authorizationCapabilities: capabilities,
      requestId: `todo-backfill-${randomUUID()}`,
    };
  }

  private async sourceActor(client: PoolClient, sourceEventId: string, requestId: string): Promise<TrustedActorContext> {
    const result = await client.query<{
      actor_id: string; actor_roles: string[]; authorization_capability: string;
    }>(
      `SELECT actor_id,actor_roles,authorization_capability
       FROM operation_events WHERE event_id=$1 FOR KEY SHARE`,
      [sourceEventId],
    );
    const source = result.rows[0];
    if (!source) throw new ApplicationError("CONFLICT", "Backfill source operation event is missing", 409);
    return {
      actorId: source.actor_id,
      actorRoles: source.actor_roles,
      authorizationCapability: source.authorization_capability,
      authorizationCapabilities: [source.authorization_capability],
      requestId,
    };
  }

  private async createRun(runId: string, watermark: Watermark, actor: TrustedActorContext): Promise<void> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const eventId = await this.events.append(client, actor, {
        action: "todo.backfill_run",
        entityType: "todo_backfill_run",
        entityId: runId,
        after: { runId, mode: "apply", eventHighWatermark: watermark },
      });
      await client.query(
        `INSERT INTO todo_backfill_runs(
           run_id,mode,status,backfill_started_at,event_high_watermark,counters,started_by
         ) VALUES($1,'apply','running',CURRENT_TIMESTAMP,$2,'{}'::jsonb,$3)`,
        [runId, watermark, actor.actorId],
      );
      await client.query("COMMIT");
      void eventId;
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async resumeRun(runId: string): Promise<StoredRun> {
    const result = await this.database.query<StoredRun>(
      `SELECT run_id,event_high_watermark,cursor,counters
       FROM todo_backfill_runs WHERE run_id=$1 AND mode='apply' AND status='running'`,
      [runId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "No resumable running backfill was found", 404);
    return row;
  }

  private async recordResume(
    runId: string,
    watermark: Watermark,
    actor: TrustedActorContext,
  ): Promise<void> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await this.events.append(client, actor, {
        action: "todo.backfill_run",
        entityType: "todo_backfill_run",
        entityId: runId,
        after: { runId, mode: "apply", resumed: true, eventHighWatermark: watermark },
      });
      await client.query("COMMIT");
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async persistProgress(runId: string, cursor: Cursor | null, counters: Counters): Promise<void> {
    await this.database.query(
      "UPDATE todo_backfill_runs SET cursor=$2,counters=$3 WHERE run_id=$1 AND status='running'",
      [runId, cursor, counters],
    );
  }

  private async completeRun(runId: string, cursor: Cursor | null, counters: Counters): Promise<void> {
    await this.database.query(
      `UPDATE todo_backfill_runs
       SET status='completed',cursor=$2,counters=$3,completed_at=CURRENT_TIMESTAMP
       WHERE run_id=$1 AND status='running'`,
      [runId, cursor, counters],
    );
  }

  private async failRun(runId: string, cursor: Cursor | null, counters: Counters, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : "unknown backfill failure";
    await this.database.query(
      `UPDATE todo_backfill_runs
       SET status='failed',cursor=$2,counters=$3,error_message=$4,completed_at=CURRENT_TIMESTAMP
       WHERE run_id=$1 AND status='running'`,
      [runId, cursor, counters, message.slice(0, 500)],
    );
  }

  private async recordException(
    runId: string,
    candidate: Candidate,
    sourceEventId: string | null,
    result: "skipped_missing_source_event" | "skipped_ambiguous_recipient" | "skipped_recipient_inactive",
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO todo_backfill_exceptions(
         exception_id,run_id,entity_type,entity_id,source_event_id,result,detail
       ) VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(run_id,entity_type,entity_id,result) DO NOTHING`,
      [randomUUID(), runId, candidate.entityType, candidate.entityId, sourceEventId, result, detail],
    );
  }
}
