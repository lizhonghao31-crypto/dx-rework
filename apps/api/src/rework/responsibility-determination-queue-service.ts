import type { ResponsibilityQueueResponse } from "@dx-rework/contracts/responsibility-queue";
import type { QueuePageQuery } from "@dx-rework/contracts";
import {queuePage,queuePageMetadata} from "./queue-page.js";
import type { Pool } from "pg";

import { isRootActor } from "../access/business-authority.js";
import type { TrustedActorContext } from "../tools/repositories.js";

type QueueRow = {
  total_count?: string;
  rework_order_id: string;
  rework_no: string | null;
  style_no: string | null;
  order_no: string | null;
  problem_part: string | null;
  problem_description: string | null;
  version: number;
  handler_user_id: string | null;
  determination_version: number | null;
  determination_stage: "draft" | "finalized" | null;
  determine_eligible: boolean;
  direct_takeover: boolean;
  direct_confirm: boolean;
  high_multiplier_pending: boolean;
};

const capabilities = (actor: TrustedActorContext): readonly string[] =>
  actor.authorizationCapabilities ?? [actor.authorizationCapability];

export class ResponsibilityDeterminationQueueService {
  constructor(private readonly database: Pool) {}

  async list(
    actor: TrustedActorContext,
    input?: QueuePageQuery,
  ): Promise<ResponsibilityQueueResponse> {
    const page=queuePage(input);
    const actorCapabilities = capabilities(actor);
    const root = isRootActor(actor);
    const hasDetermine = root || actorCapabilities.includes("responsibility:determine");
    const hasTakeover = root || actorCapabilities.includes("responsibility:takeover");
    const hasConfirm = root || actorCapabilities.includes(
      "responsibility:confirm_high_multiplier",
    );

    const pmcRead = actor.actorRoles.includes("pmc") && actorCapabilities.includes("external_responsibility:view")
      && (await this.database.query<{allowed:boolean}>("SELECT responsibility_actor_has_direct_role($1,'external_responsibility:view',ARRAY['pmc']) allowed",[actor.actorId])).rows[0]?.allowed === true;
    if (!hasDetermine && !hasTakeover && !hasConfirm && !pmcRead) {
      return { items: [],...queuePageMetadata(page,0) };
    }

    const scope=`FROM rework_orders order_record
       WHERE order_record.status='pending_responsibility_determination'
         AND (
           $5::boolean OR ($2::boolean AND responsibility_can_determine(
             $1,
             order_record.rework_order_id
           ))
           OR ($3::boolean AND responsibility_actor_has_direct_role(
             $1,
             'responsibility:takeover',
             ARRAY['owner_group']
           ))
           OR ($4::boolean AND responsibility_actor_has_direct_role(
             $1,
             'responsibility:confirm_high_multiplier',
             ARRAY['owner_group']
           ))
         )
`;
    const details=`SELECT order_record.rework_order_id,
              order_record.rework_no,
              order_record.style_no,
              order_record.order_no,
              order_record.problem_part,
              order_record.problem_description,
              order_record.version,
              responsibility_effective_handler(order_record.rework_order_id)
                handler_user_id,
              leaf.determination_version,
              leaf.stage determination_stage,
              responsibility_can_determine($1,order_record.rework_order_id)
                determine_eligible,
              responsibility_actor_has_direct_role(
                $1,
                'responsibility:takeover',
                ARRAY['owner_group']
              ) direct_takeover,
              responsibility_actor_has_direct_role(
                $1,
                'responsibility:confirm_high_multiplier',
                ARRAY['owner_group']
              ) direct_confirm,
              coalesce(
                leaf.stage='draft'
                AND EXISTS(
                  SELECT 1
                  FROM rework_responsibility_processes process
                  WHERE process.determination_id=leaf.determination_id
                    AND process.multiplier>2
                )
                AND NOT EXISTS(
                  SELECT 1
                  FROM rework_responsibility_high_multiplier_confirmations confirmation
                  WHERE confirmation.determination_id=leaf.determination_id
                ),
                false
              ) high_multiplier_pending
       FROM rework_orders order_record
       LEFT JOIN LATERAL (
         SELECT determination.determination_id,
                determination.determination_version,
                determination.stage,
                determination.created_by
         FROM rework_responsibility_determinations determination
         WHERE determination.rework_order_id=order_record.rework_order_id
           AND NOT EXISTS(
             SELECT 1
             FROM rework_responsibility_determinations successor
             WHERE successor.replaces_determination_id=determination.determination_id
           )
         ORDER BY determination.determination_version DESC
         LIMIT 1
       ) leaf ON true
       WHERE order_record.status='pending_responsibility_determination'
         AND (
           $5::boolean OR ($2::boolean AND responsibility_can_determine(
             $1,
             order_record.rework_order_id
           ))
           OR ($3::boolean AND responsibility_actor_has_direct_role(
             $1,
             'responsibility:takeover',
             ARRAY['owner_group']
           ))
           OR ($4::boolean AND responsibility_actor_has_direct_role(
             $1,
             'responsibility:confirm_high_multiplier',
             ARRAY['owner_group']
           ))
         )
`;
    const result = await this.database.query<QueueRow>(page ? `
      WITH queue_matches AS MATERIALIZED (
        SELECT order_record.rework_order_id,
               row_number() OVER (ORDER BY order_record.updated_at,order_record.rework_order_id) ordinal
        ${scope} AND ($6::text='' OR position(lower($6::text) in lower(concat_ws(' ',nullif(order_record.rework_no,''),nullif(order_record.style_no,''),nullif(order_record.order_no,''),nullif(order_record.problem_part,''))))>0)
      ), queue_page AS MATERIALIZED (
        SELECT * FROM queue_matches ORDER BY ordinal LIMIT 15 OFFSET $7
      )
      SELECT totals.total_count,details.* FROM (SELECT count(*)::text total_count FROM queue_matches) totals
      LEFT JOIN queue_page selected ON true
      LEFT JOIN LATERAL (${details} AND order_record.rework_order_id=selected.rework_order_id) details ON true
      ORDER BY selected.ordinal` : `${details} ORDER BY order_record.updated_at,order_record.rework_order_id LIMIT 200`,
      [actor.actorId,hasDetermine,hasTakeover,hasConfirm,pmcRead,...(page?[page.search,page.offset]:[])],
    );

    return {
      ...queuePageMetadata(page,Number(result.rows[0]?.total_count??0)),
      items: result.rows.filter(row=>row.rework_order_id).map((row) => ({
        reworkOrderId: row.rework_order_id,
        reworkNo: row.rework_no,
        styleNo: row.style_no,
        orderNo: row.order_no,
        problemPart: row.problem_part,
        problemDescription: row.problem_description,
        orderVersion: row.version,
        handlerUserId: row.handler_user_id,
        determinationVersion: row.determination_version,
        determinationStage: row.determination_stage,
        canDetermine:
          hasDetermine &&
          row.determine_eligible &&
          (root || row.handler_user_id === null || row.handler_user_id === actor.actorId),
        canTakeover:
          hasTakeover &&
          (root || row.direct_takeover) &&
          row.handler_user_id !== actor.actorId,
        canConfirmHighMultiplier:
          hasConfirm &&
          (root || row.direct_confirm) &&
          row.determination_stage === "draft" &&
          row.high_multiplier_pending,
        highMultiplierPending: row.high_multiplier_pending,
      })),
    };
  }
}
