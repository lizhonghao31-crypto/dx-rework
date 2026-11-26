import {cumulativeSourcingTiming,type SourcingCaseListResponse,type SourcingCaseSummary,type SourcingCaseStatus,type SourcingHistoryNode} from "@dx-rework/contracts";
import type {Pool,PoolClient} from "pg";
import type {TrustedActorContext} from "../tools/repositories.js";
import {ApplicationError} from "../platform/errors.js";
import {effectiveSourcingMerchandiser} from "./current-merchandiser.js";
import {resolveDigitalChild} from "../production-platform/child-link-repository.js";
import {currentFactoryPagePoLines,factoryPoLines,factoryProposals} from "../production-platform/po-factory-date-adapter.js";
import {assertContractReturnCaseClocks,assertContractReturnListClock,contractReturnClock} from "./contract-return-clock.js";
import type {ContractReturnFilter} from "./contract-return-state.js";
import {mapSourcingCase as mapCase,toSourcingIso as toIso,type SourcingCaseRow} from "./sourcing-case-mapping.js";
import {sourcingIeHistoryAll,sourcingIeHistoryPredicate} from "./sourcing-ie-directory.js";

const SOURCING_LIST_PAGE_SIZE=15;
const fail=(message:string,status=400,code="VALIDATION_ERROR"):never=>{throw new ApplicationError(code,message,status);};
export type SourcingCaseHistory=Readonly<{at:string;node:SourcingHistoryNode;entryId:string}>;
export const sourcingCaseStages=['all','ie','ie_history','management','owner','finance','factory_change','exception'] as const;
export type SourcingCaseStage=(typeof sourcingCaseStages)[number];
export type SourcingCaseListSelection=Readonly<{
 normalizedQuery:string;statusFilter:"all"|"pending"|"closed";page:number;
 stage:SourcingCaseStage;
 gender:"all"|"男装"|"女装"|"missing";normalizedStyleName:string;contractReturn:ContractReturnFilter|null;
}>;

/** Internal read only. The caller retains authorization and transaction ownership;
 * command read-back must supply its existing client, never another pool read. */
export async function readSourcingCase(database:Pool,client:Pick<PoolClient,"query">,sourcingCaseId:string,actor:TrustedActorContext,history?:SourcingCaseHistory):Promise<SourcingCaseSummary>{
    const result = await client.query<SourcingCaseRow>(
      `SELECT
         case_view.sourcing_case_id,case_view.erp_order_id,case_view.erp_order_no,
         COALESCE(to_jsonb(source_case)->>'workflow_generation','legacy') AS workflow_generation,
         case_view.style_no,case_view.lane_key,source_case.order_quantity,
         (SELECT COALESCE(max(revision),0) FROM sourcing_style_revisions WHERE sourcing_case_id=case_view.sourcing_case_id) AS identity_revision,
         source_case.gender,source_case.style_name_snapshot,
         COALESCE((
            SELECT correction.new_unit_price FROM sourcing_budget_price_corrections correction
            WHERE correction.sourcing_case_id=source_case.sourcing_case_id
              ${history ? "AND correction.corrected_at <= $2::timestamptz" : ""}
            ORDER BY correction.correction_version DESC LIMIT 1
          ),source_case.daxing_unit_price)::text AS daxing_unit_price,
         to_char(source_case.estimated_cut_piece_send_date,'YYYY-MM-DD')
           AS estimated_cut_piece_send_date,
         lines_row.line_items,
         to_char(sourcing_effective_delivery_date(case_view.sourcing_case_id,source_case.delivery_date${history ? ', $2::timestamptz' : ''}),'YYYY-MM-DD') AS delivery_date,
         case_view.process_description,case_view.process_items,
         COALESCE(decision_row.crafts,crafts_row.crafts) AS crafts,
         case_view.status,case_view.version,case_view.created_by,
         concat_ws('/',creator_user.display_name,additional_user.display_name) AS merchandiser_name,
         case_view.created_at,case_view.updated_at,
         COALESCE(monitor_case.contract_return_monitor_enabled,false) AS contract_return_monitor_enabled,
          COALESCE(monitor_case.contract_return_catchup,false) AS contract_return_catchup,monitor_case.contract_generated_at,
         monitor_case.contract_return_due_at,monitor_case.contract_returned_at,
         sourcing_contract_return_elapsed_seconds(
           monitor_case.contract_return_due_at,COALESCE(monitor_case.contract_returned_at,monitor_case.business_as_of)
         ) AS contract_return_overdue_seconds,
         monitor_case.business_as_of AS contract_return_as_of,monitor_case.time_quality,monitor_case.time_reason,
         (SELECT to_jsonb(adopted)->>'adopted_budget_order_id' FROM sourcing_ie_quotes adopted
          WHERE adopted.sourcing_case_id=case_view.sourcing_case_id ORDER BY adopted.quote_version DESC LIMIT 1) AS original_ie_budget_order_id,
         quote_row.sourcing_ie_quote_id,quote_row.quote_version,
         quote_row.unit_price,quote_row.quantity AS quote_quantity,
         quote_row.total_amount,quote_row.quote_reason,
         quote_lines_row.line_prices AS quote_line_prices,
         quote_row.quoted_by,quote_row.quoted_at,
         to_jsonb(quote_row)->>'adopted_budget_order_id' AS adopted_budget_order_id,
         (to_jsonb(quote_row)->>'adopted_budget_version')::int AS adopted_budget_version,
         to_jsonb(quote_row)->>'adopted_quotation_row_id' AS adopted_quotation_row_id,
         decision_row.sourcing_decision_id,decision_row.decision_version,
         decision_row.source_type,decision_row.source_ie_quote_id,
         decision_row.supersedes_decision_id,decision_row.supplier_id,
         decision_row.supplier_code_snapshot,decision_row.supplier_name_snapshot,
         decision_row.unit_price AS decision_unit_price,
         decision_row.quantity AS decision_quantity,
         decision_row.total_amount AS decision_total_amount,
         decision_lines_row.line_prices AS decision_line_prices,
         decision_row.cutting_process,decision_row.cutting_process_other,
         decision_row.decision_reason AS management_decision_reason,
         decision_row.decided_by AS management_decided_by,
         decision_row.decided_at AS management_decided_at,
         owner_row.sourcing_owner_decision_id,
         owner_row.sourcing_decision_id AS owner_sourcing_decision_id,
         owner_row.decision AS owner_decision,
         owner_row.decision_reason AS owner_decision_reason,
         owner_row.decided_by AS owner_decided_by,
         owner_row.decided_at AS owner_decided_at,
         snapshot.sourcing_approval_snapshot_id,
         snapshot.sourcing_decision_id AS approval_decision_id,
         snapshot.decision_version AS approval_decision_version,
         snapshot.supplier_id AS approval_supplier_id,
         snapshot.supplier_code_snapshot AS approval_supplier_code,
         snapshot.supplier_name_snapshot AS approval_supplier_name,
         snapshot.quantity AS approval_quantity,
         snapshot.total_amount AS approval_total_amount,
         snapshot.daxing_unit_price::text AS approval_daxing_unit_price,
         to_char(snapshot.estimated_cut_piece_send_date,'YYYY-MM-DD') AS approval_estimated_cut_piece_send_date,
         to_char(snapshot.delivery_date,'YYYY-MM-DD') AS approval_delivery_date,
         snapshot.gender AS approval_gender,snapshot.style_name_snapshot AS approval_style_name,
         snapshot.processes AS approval_processes,
         snapshot_lines.line_prices AS approval_line_prices,
         snapshot.approved_by AS approval_by,snapshot.approved_at AS approval_at
       FROM current_sourcing_cases case_view
       JOIN LATERAL sourcing_case_facts_at(case_view.sourcing_case_id${history ? ', $2::timestamptz' : ''}) source_case ON true
       JOIN app_users creator_user ON creator_user.id=case_view.created_by
       JOIN sourcing_cases additional_case ON additional_case.sourcing_case_id=case_view.sourcing_case_id
       LEFT JOIN LATERAL (SELECT string_agg(p.display_name,'/' ORDER BY selected.position) AS display_name
        FROM unnest(sourcing_additional_merchandiser_ids(additional_case.sourcing_case_id)) WITH ORDINALITY selected(user_id,position)
        JOIN app_users p ON p.id=selected.user_id) additional_user ON true
       LEFT JOIN LATERAL sourcing_contract_return_business_state(case_view.sourcing_case_id) monitor_case ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(
           jsonb_build_object(
             'position',line.position,
             'styleNo',${history ? 'line.historical_style_no' : 'line.style_no'},'formalStyleNo',line.formal_style_no,'imageAttachmentId',line.image_attachment_id,
             'alternateStyleNo',${history ? 'line.historical_alternate' : 'line.alternate_style_no'},
             'color',line.color,
             'quantity',line.quantity,
             'externalUnitPrice',line.external_unit_price::text,
             'legacy',line.legacy_source
           )
           ORDER BY line.position
         ) AS line_items
         FROM ${history ? `(SELECT original.*,
           COALESCE(identity.style_no,identity.alternate_style_no) AS historical_style_no,
           identity.style_no AS formal_style_no, identity.alternate_style_no AS historical_alternate
           FROM sourcing_case_lines_at(case_view.sourcing_case_id, $2::timestamptz) original
           LEFT JOIN LATERAL (SELECT revision,lines FROM sourcing_style_revisions
             WHERE sourcing_case_id=original.sourcing_case_id AND created_at <= $2::timestamptz
             ORDER BY revision DESC LIMIT 1) revision ON true
           LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(revision.lines)
             WHERE (value->>'position')::integer=original.position) revised ON true
           CROSS JOIN LATERAL (SELECT
             CASE WHEN revision.revision IS NULL THEN original.style_no ELSE revised.value->>'styleNo' END AS style_no,
             CASE WHEN revision.revision IS NULL THEN original.alternate_style_no ELSE revised.value->>'alternateStyleNo' END AS alternate_style_no
           ) identity) line` : "current_sourcing_case_lines line"}
         WHERE line.sourcing_case_id=case_view.sourcing_case_id
       ) lines_row ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(
           jsonb_build_object(
             'position',binding.position,
             'craftId',binding.craft_id,
             'craftCode',binding.craft_code_snapshot,
             'craftVersion',binding.craft_version,
             'craftName',binding.craft_name_snapshot
           )
           ORDER BY binding.position
         ) AS crafts
         FROM sourcing_case_crafts binding
         WHERE binding.sourcing_case_id=case_view.sourcing_case_id
       ) crafts_row ON true
       LEFT JOIN LATERAL (
         SELECT quote.*
         FROM sourcing_ie_quotes quote
         WHERE quote.sourcing_case_id=case_view.sourcing_case_id
           ${history ? "AND COALESCE((SELECT adoption.created_at FROM operation_events adoption WHERE adoption.event_id=quote.operation_event_id AND adoption.action='sourcing.ie_basis.adopt'),quote.quoted_at) <= $2::timestamptz AND $3::text <> 'created' AND ($3::text <> 'ie_quote' OR quote.sourcing_ie_quote_id=$4::uuid)" : "AND (quote.quoted_at > COALESCE((SELECT max(transitioned_at) FROM sourcing_case_transitions WHERE sourcing_case_id=case_view.sourcing_case_id AND business_action='returned_to_merchandiser'), '-infinity'::timestamptz) OR (to_jsonb(quote)->>'adopted_budget_order_id' IS NOT NULL AND (SELECT business_action FROM sourcing_case_transitions WHERE sourcing_case_id=case_view.sourcing_case_id AND business_action IN ('returned_to_merchandiser','correction_retained_ie_basis') ORDER BY sequence DESC LIMIT 1)='correction_retained_ie_basis'))"}
         ORDER BY quote.quote_version DESC
         LIMIT 1
       ) quote_row ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'position',line.position,'quantity',line.quantity,
           'unitPrice',line.unit_price::text,'totalAmount',line.total_amount::text
         ) ORDER BY line.position) AS line_prices
         FROM sourcing_ie_quote_lines line
         WHERE line.sourcing_ie_quote_id=quote_row.sourcing_ie_quote_id
       ) quote_lines_row ON true
       LEFT JOIN LATERAL (
         SELECT decision_fact.*
         FROM sourcing_decisions decision_fact
         WHERE decision_fact.sourcing_case_id=case_view.sourcing_case_id
           ${history ? "AND decision_fact.decided_at <= $2::timestamptz AND $3::text NOT IN ('created','ie_quote') AND ($3::text <> 'management' OR decision_fact.sourcing_decision_id=$4::uuid) AND ($3::text <> 'owner' OR decision_fact.sourcing_decision_id=(SELECT sourcing_decision_id FROM sourcing_owner_decisions WHERE sourcing_owner_decision_id=$4::uuid)) AND ($3::text <> 'finance' OR decision_fact.sourcing_decision_id=(SELECT sourcing_decision_id FROM sourcing_finance_reconciliations WHERE sourcing_reconciliation_id=$4::uuid))" : "AND decision_fact.decided_at > COALESCE((SELECT max(transitioned_at) FROM sourcing_case_transitions WHERE sourcing_case_id=case_view.sourcing_case_id AND business_action='returned_to_merchandiser'), '-infinity'::timestamptz)"}
         ORDER BY decision_fact.decision_version DESC
         LIMIT 1
       ) decision_row ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'position',line.position,'quantity',line.quantity,
           'unitPrice',line.unit_price::text,'totalAmount',line.total_amount::text
         ) ORDER BY line.position) AS line_prices
         FROM sourcing_decision_lines line
         WHERE line.sourcing_decision_id=decision_row.sourcing_decision_id
       ) decision_lines_row ON true
       LEFT JOIN sourcing_owner_decisions owner_row
         ON owner_row.sourcing_decision_id=decision_row.sourcing_decision_id
         ${history ? "AND owner_row.decided_at <= $2::timestamptz AND $3::text IN ('owner','finance') AND ($3::text <> 'owner' OR owner_row.sourcing_owner_decision_id=$4::uuid)" : ""}
       LEFT JOIN LATERAL (
         SELECT approval.*
         FROM sourcing_approval_snapshots approval
         WHERE approval.sourcing_case_id=case_view.sourcing_case_id
           ${history ? "AND approval.approved_at <= $2::timestamptz AND $3::text IN ('owner','finance') AND ($3::text<>'finance' OR approval.sourcing_decision_id=decision_row.sourcing_decision_id)" : ""}
         ORDER BY approval.decision_version DESC LIMIT 1
       ) snapshot ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'position',line.position,'styleNo',line.style_no,
           'alternateStyleNo',line.alternate_style_no,'color',line.color,
           'quantity',line.quantity,'unitPrice',line.unit_price::text,
           'totalAmount',line.total_amount::text
         ) ORDER BY line.position) AS line_prices
         FROM sourcing_approval_snapshot_lines line
         WHERE line.sourcing_approval_snapshot_id=snapshot.sourcing_approval_snapshot_id
       ) snapshot_lines ON true
       WHERE case_view.sourcing_case_id=$1`,
      history ? [sourcingCaseId, history.at, history.node, history.entryId] : [sourcingCaseId],
    );
    let row = result.rows[0];
    if (!row) return fail("报价选厂询价不存在", 404, "NOT_FOUND");
    if (row.workflow_generation === "digital_production_v1") await resolveDigitalChild(client, "sourcing", sourcingCaseId, row.workflow_generation);
    row={...row,effective_created_by:await effectiveSourcingMerchandiser(client,sourcingCaseId,row.created_by,row.workflow_generation)};
    if(!history&&row.workflow_generation==="digital_production_v1")row={...row,merchandiser_name:(await client.query(`SELECT concat_ws('/',current_person.display_name,additional.display_name) AS name FROM sourcing_cases source
      LEFT JOIN app_users current_person ON current_person.id=$2
      LEFT JOIN LATERAL (SELECT string_agg(p.display_name,'/' ORDER BY selected.position) AS display_name
       FROM unnest(sourcing_additional_merchandiser_ids(source.sourcing_case_id)) WITH ORDINALITY selected(user_id,position)
       JOIN app_users p ON p.id=selected.user_id WHERE selected.user_id IS DISTINCT FROM $2::uuid) additional ON true
      WHERE source.sourcing_case_id=$1`,[sourcingCaseId,row.effective_created_by])).rows[0]?.name??null};
    if(!history)await contractReturnClock(database,client,sourcingCaseId);
    const item = mapCase(history ? { ...row,contract_return_monitor_enabled:false } : row, actor);
    if (row.workflow_generation === "digital_production_v1") {
      const lines = (await factoryPoLines(client,sourcingCaseId,history?.at ?? null))!;
      const proposals = await factoryProposals(client,sourcingCaseId,history?.at ?? null);
      item.lineItems = item.lineItems.map(line => { const po=lines.find(po=>po.position===line.position); return po ? {...line,lineId:po.line_id,...(history?{}:{customerWarehouseArrivalDate:po.customer}),factoryDeliveryDate:po.factory,proposedFactoryDeliveryDate:proposals[line.position-1]?.factoryDeliveryDate ?? null}:line; });
      if(item.approvalSnapshot) {
        const frozen = (await factoryPoLines(client,sourcingCaseId,null,item.approvalSnapshot.sourcingApprovalSnapshotId))!;
        item.approvalSnapshot.linePrices=item.approvalSnapshot.linePrices.map(line=>{const po=frozen.find(po=>po.position===line.position);return po?{...line,lineId:po.line_id,factoryDeliveryDate:po.factory}:line;});
      }
    }
    if (history) {
      item.styleNo = item.lineItems[0]?.styleNo ?? item.styleNo;
      // Current lifecycle/version are not a historical state; never present them as such.
      item.updatedAt = toIso(history.at);
      const transition = await client.query<{ status: SourcingCaseStatus; version: number }>(
        `SELECT to_status AS status,sequence AS version FROM sourcing_case_transitions
         WHERE sourcing_case_id=$1 AND transitioned_at <= $2::timestamptz ORDER BY sequence DESC LIMIT 1`,
        [sourcingCaseId, history.at]);
      if (transition.rows[0]) { item.status = transition.rows[0].status; item.version = Number(transition.rows[0].version); }
      delete item.identityRevision;
    }
    const latestReturn = history ? null : (await client.query<{reason:string}>(
      "SELECT transition_reason AS reason FROM sourcing_case_transitions WHERE sourcing_case_id=$1 AND business_action='returned_to_merchandiser' ORDER BY sequence DESC LIMIT 1",[sourcingCaseId])).rows[0];
    const visits = await client.query<{to:string;changesNode:boolean;enteredAt:string;leftAt:string|null;asOf:string}>(
      `SELECT to_status AS to,true AS "changesNode",transitioned_at::text AS "enteredAt",
        lead(transitioned_at) OVER(ORDER BY sequence)::text AS "leftAt",CURRENT_TIMESTAMP::text AS "asOf"
       FROM sourcing_case_transitions WHERE sourcing_case_id=$1 AND from_status IS DISTINCT FROM to_status
         AND ($2::timestamptz IS NULL OR transitioned_at<=$2::timestamptz)
       ORDER BY sequence`,[sourcingCaseId,history?.at ?? null]);
    const timing=cumulativeSourcingTiming(visits.rows,item.createdAt,history?.at ?? visits.rows[0]?.asOf ?? item.createdAt);
    return {...item, correctionReason: latestReturn?.reason ?? null,timing};
}

/** PERF09 query is intentionally kept independent from detail/history loading. */
export async function readSourcingCaseList(database:Pool,actor:TrustedActorContext,selection:SourcingCaseListSelection):Promise<SourcingCaseListResponse>{
 const {normalizedQuery,statusFilter,page,stage,gender,normalizedStyleName,contractReturn}=selection;
 const ieHistory=stage==='ie_history';
    const offset = (page - 1) * SOURCING_LIST_PAGE_SIZE;
    const principalAvailable=Boolean((await database.query("SELECT to_regclass('digital_production_child_links') AS relation")).rows[0]?.relation);
    const principalJoins=principalAvailable?`LEFT JOIN digital_production_child_links principal_link ON principal_link.module='sourcing' AND principal_link.child_id=case_view.sourcing_case_id
      LEFT JOIN digital_production_orders principal_order ON principal_order.production_order_id=principal_link.production_order_id
      LEFT JOIN app_users principal_user ON principal_user.id=principal_order.primary_merchandiser_id`:"";
    await assertContractReturnListClock(database);
    const result = await database.query<SourcingCaseRow>(
      `WITH filtered_cases AS MATERIALIZED (
       SELECT case_view.sourcing_case_id,case_view.created_at,case_view.order_quantity,
         case_view.erp_order_id,case_view.erp_order_no,case_view.style_no,case_view.lane_key,
         case_view.delivery_date,case_view.process_description,case_view.process_items,
         case_view.status,case_view.version,case_view.created_by,case_view.updated_at,
         COALESCE(to_jsonb(additional_case)->>'workflow_generation','legacy') AS workflow_generation,
         ${principalAvailable?"CASE WHEN to_jsonb(additional_case)->>'workflow_generation'='digital_production_v1' THEN principal_order.primary_merchandiser_id ELSE case_view.created_by END AS effective_created_by,":""}
         ${principalAvailable?"CASE WHEN to_jsonb(additional_case)->>'workflow_generation'='digital_production_v1' THEN concat_ws('/',principal_user.display_name,additional_user.display_name) ELSE concat_ws('/',creator_user.display_name,additional_user.display_name) END":"concat_ws('/',creator_user.display_name,additional_user.display_name)"} AS merchandiser_name,
         source_case.gender,source_case.style_name_snapshot,source_case.daxing_unit_price AS original_daxing_unit_price,
         source_case.estimated_cut_piece_send_date AS original_send_date,
         monitor_case.contract_return_monitor_enabled, monitor_case.contract_return_catchup, monitor_case.contract_generated_at, monitor_case.contract_return_due_at, monitor_case.contract_returned_at, monitor_case.business_as_of, monitor_case.time_quality, monitor_case.time_reason,
         decision_row.sourcing_decision_id AS selected_decision_id
       FROM current_sourcing_cases case_view
       JOIN LATERAL sourcing_case_facts_at(case_view.sourcing_case_id) source_case ON true
       LEFT JOIN LATERAL sourcing_contract_return_business_state(case_view.sourcing_case_id) monitor_case ON true
       JOIN app_users creator_user ON creator_user.id=case_view.created_by
       JOIN sourcing_cases additional_case ON additional_case.sourcing_case_id=case_view.sourcing_case_id
       LEFT JOIN LATERAL (SELECT string_agg(p.display_name,'/' ORDER BY selected.position) AS display_name
        FROM unnest(sourcing_additional_merchandiser_ids(additional_case.sourcing_case_id)) WITH ORDINALITY selected(user_id,position)
        JOIN app_users p ON p.id=selected.user_id) additional_user ON true
       ${principalJoins}
       LEFT JOIN LATERAL (
         SELECT decision_fact.*
         FROM sourcing_decisions decision_fact
         WHERE decision_fact.sourcing_case_id=case_view.sourcing_case_id
         AND decision_fact.decided_at > COALESCE((SELECT max(transitioned_at) FROM sourcing_case_transitions WHERE sourcing_case_id=case_view.sourcing_case_id AND business_action='returned_to_merchandiser'), '-infinity'::timestamptz)
         ORDER BY decision_fact.decision_version DESC
         LIMIT 1
       ) decision_row ON true
       WHERE ($1='' OR case_view.erp_order_no ILIKE '%'||$1||'%'
          OR case_view.style_no ILIKE '%'||$1||'%'
          OR EXISTS(SELECT 1 FROM sourcing_style_aliases alias WHERE alias.sourcing_case_id=case_view.sourcing_case_id AND alias.style_no ILIKE '%'||$1||'%')
          OR EXISTS (
            SELECT 1
            FROM sourcing_case_lines search_line
            WHERE search_line.sourcing_case_id=case_view.sourcing_case_id
              AND (
                search_line.style_no ILIKE '%'||$1||'%'
                OR search_line.alternate_style_no ILIKE '%'||$1||'%'
                OR search_line.color ILIKE '%'||$1||'%'
              )
          )
          OR creator_user.display_name ILIKE '%'||$1||'%'
          ${principalAvailable?"OR principal_user.display_name ILIKE '%'||$1||'%'":""}
          OR additional_user.display_name ILIKE '%'||$1||'%'
          OR decision_row.supplier_name_snapshot ILIKE '%'||$1||'%'
          OR decision_row.supplier_code_snapshot ILIKE '%'||$1||'%'
          OR case_view.process_description ILIKE '%'||$1||'%'
          OR source_case.gender ILIKE '%'||$1||'%'
          OR source_case.style_name_snapshot ILIKE '%'||$1||'%'
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(decision_row.crafts) craft
            WHERE craft->>'craftName' ILIKE '%'||$1||'%'
          )
          OR EXISTS (
            SELECT 1
            FROM sourcing_contract_executions contract_row
            WHERE contract_row.sourcing_case_id=case_view.sourcing_case_id
              AND contract_row.contract_reference ILIKE '%'||$1||'%'
          ))
         AND ($2::text='all' OR ($2::text='closed' AND case_view.status='closed')
           OR ($2::text='pending' AND case_view.status<>'closed'))
         AND (
           $3::text='all'
           OR ($3::text='ie' AND case_view.status='pending_ie_quote')
           ${ieHistory?`OR ${sourcingIeHistoryPredicate('$8','$9')}`:''}
           OR ($3::text='management' AND case_view.status='pending_management_decision')
           OR ($3::text='owner' AND case_view.status='pending_owner_approval')
           OR ($3::text='finance' AND case_view.status IN ('pending_contract','pending_finance_reconciliation'))
           OR ($3::text='factory_change' AND case_view.status='pending_factory_change_verification')
           OR ($3::text='exception' AND case_view.status='pending_exception_verification')
         )
         AND (
           $4::text='all'
           OR ($4::text='missing' AND source_case.gender IS NULL)
           OR ($4::text IN ('男装','女装') AND source_case.gender=$4::text)
         )
         AND (
           $5::text=''
           OR ($5::text='历史未维护' AND (source_case.style_name_snapshot IS NULL OR btrim(source_case.style_name_snapshot)=''))
           OR ($5::text<>'历史未维护' AND source_case.style_name_snapshot ILIKE '%'||$5::text||'%')
         )
         AND (
           $6::text IS NULL
           OR (
             monitor_case.contract_return_monitor_enabled
             AND (
               $6::text='all'
               OR (monitor_case.time_quality<>'unknown' AND ( ($6::text='pending' AND monitor_case.contract_returned_at IS NULL
                 AND (monitor_case.contract_return_due_at IS NULL
                   OR monitor_case.business_as_of<=monitor_case.contract_return_due_at))
               OR ($6::text='returned_on_time' AND monitor_case.contract_returned_at IS NOT NULL
                 AND (monitor_case.contract_return_due_at IS NULL
                   OR monitor_case.contract_returned_at<=monitor_case.contract_return_due_at))
               OR ($6::text='overdue_pending'
                 AND monitor_case.contract_returned_at IS NULL
                 AND monitor_case.business_as_of>monitor_case.contract_return_due_at)
               OR ($6::text='returned_late'
                 AND monitor_case.contract_returned_at>monitor_case.contract_return_due_at)
               OR ($6::text='all_overdue' AND (
                 monitor_case.contract_returned_at>monitor_case.contract_return_due_at
                 OR (monitor_case.contract_returned_at IS NULL AND monitor_case.business_as_of>monitor_case.contract_return_due_at)
               ))
               ))
             )
           )
         )
       ), page_cases AS MATERIALIZED (
         SELECT * FROM filtered_cases
         ORDER BY created_at DESC,sourcing_case_id DESC
         LIMIT 15 OFFSET $7
       ), case_details AS (
       SELECT
         case_view.workflow_generation,
         case_view.sourcing_case_id,case_view.erp_order_id,case_view.erp_order_no,
         case_view.style_no,case_view.lane_key,case_view.order_quantity,
         (SELECT COALESCE(max(revision),0) FROM sourcing_style_revisions WHERE sourcing_case_id=case_view.sourcing_case_id) AS identity_revision,
         source_case.gender,source_case.style_name_snapshot,
         ${principalAvailable?"case_view.effective_created_by,":""}
         case_view.merchandiser_name,
         first_image.attachment_id AS first_image_attachment_id,
         COALESCE((
            SELECT correction.new_unit_price FROM sourcing_budget_price_corrections correction
            WHERE correction.sourcing_case_id=source_case.sourcing_case_id
            ORDER BY correction.correction_version DESC LIMIT 1
          ),source_case.daxing_unit_price)::text AS daxing_unit_price,
         to_char(source_case.estimated_cut_piece_send_date,'YYYY-MM-DD')
           AS estimated_cut_piece_send_date,
         lines_row.line_items,
         to_char(sourcing_effective_delivery_date(case_view.sourcing_case_id,case_view.delivery_date),'YYYY-MM-DD') AS delivery_date,
         case_view.process_description,case_view.process_items,
         COALESCE(decision_row.crafts,crafts_row.crafts) AS crafts,
         case_view.status,case_view.version,case_view.created_by,
         case_view.created_at,case_view.updated_at,
         COALESCE(monitor_case.contract_return_monitor_enabled,false) AS contract_return_monitor_enabled,
          COALESCE(monitor_case.contract_return_catchup,false) AS contract_return_catchup,monitor_case.contract_generated_at,
         monitor_case.contract_return_due_at,monitor_case.contract_returned_at,
         sourcing_contract_return_elapsed_seconds(
           monitor_case.contract_return_due_at,COALESCE(monitor_case.contract_returned_at,monitor_case.business_as_of)
         ) AS contract_return_overdue_seconds,
         monitor_case.business_as_of AS contract_return_as_of,monitor_case.time_quality,monitor_case.time_reason,
         quote_row.sourcing_ie_quote_id,quote_row.quote_version,
         quote_row.unit_price,quote_row.quantity AS quote_quantity,
         quote_row.total_amount,quote_row.quote_reason,
         quote_lines_row.line_prices AS quote_line_prices,
         quote_row.quoted_by,quote_row.quoted_at,
         to_jsonb(quote_row)->>'adopted_budget_order_id' AS adopted_budget_order_id,
         (to_jsonb(quote_row)->>'adopted_budget_version')::int AS adopted_budget_version,
         to_jsonb(quote_row)->>'adopted_quotation_row_id' AS adopted_quotation_row_id,
         decision_row.sourcing_decision_id,decision_row.decision_version,
         decision_row.source_type,decision_row.source_ie_quote_id,
         decision_row.supersedes_decision_id,decision_row.supplier_id,
         decision_row.supplier_code_snapshot,decision_row.supplier_name_snapshot,
         decision_row.unit_price AS decision_unit_price,
         decision_row.quantity AS decision_quantity,
         decision_row.total_amount AS decision_total_amount,
         decision_lines_row.line_prices AS decision_line_prices,
         decision_row.cutting_process,decision_row.cutting_process_other,
         decision_row.decision_reason AS management_decision_reason,
         decision_row.decided_by AS management_decided_by,
         decision_row.decided_at AS management_decided_at,
         owner_row.sourcing_owner_decision_id,
         owner_row.sourcing_decision_id AS owner_sourcing_decision_id,
         owner_row.decision AS owner_decision,
         owner_row.decision_reason AS owner_decision_reason,
         owner_row.decided_by AS owner_decided_by,
         owner_row.decided_at AS owner_decided_at,
         snapshot.sourcing_approval_snapshot_id,
         snapshot.sourcing_decision_id AS approval_decision_id,
         snapshot.decision_version AS approval_decision_version,
         snapshot.supplier_id AS approval_supplier_id,
         snapshot.supplier_code_snapshot AS approval_supplier_code,
         snapshot.supplier_name_snapshot AS approval_supplier_name,
         snapshot.quantity AS approval_quantity,
         snapshot.total_amount AS approval_total_amount,
         snapshot.daxing_unit_price::text AS approval_daxing_unit_price,
         to_char(snapshot.estimated_cut_piece_send_date,'YYYY-MM-DD') AS approval_estimated_cut_piece_send_date,
         to_char(snapshot.delivery_date,'YYYY-MM-DD') AS approval_delivery_date,
         snapshot.gender AS approval_gender,snapshot.style_name_snapshot AS approval_style_name,
         snapshot.processes AS approval_processes,
         snapshot_lines.line_prices AS approval_line_prices,
         snapshot.approved_by AS approval_by,snapshot.approved_at AS approval_at
       FROM page_cases case_view
       CROSS JOIN LATERAL (SELECT case_view.sourcing_case_id,case_view.gender,case_view.style_name_snapshot,
         case_view.original_daxing_unit_price AS daxing_unit_price,case_view.original_send_date AS estimated_cut_piece_send_date) source_case
       CROSS JOIN LATERAL (SELECT case_view.contract_return_monitor_enabled, case_view.contract_return_catchup, case_view.contract_generated_at, case_view.contract_return_due_at, case_view.contract_returned_at, case_view.business_as_of, case_view.time_quality, case_view.time_reason) monitor_case
       LEFT JOIN LATERAL (
         SELECT after_state->'attachmentIds' AS ids FROM operation_events
         WHERE entity_type='sourcing_case' AND entity_id=case_view.sourcing_case_id::text
           AND action IN ('sourcing.case.correct','sourcing.attachments.supplement','sourcing.case.create')
           AND jsonb_typeof(after_state->'attachmentIds')='array'
         ORDER BY created_at DESC, CASE WHEN action='sourcing.case.correct' THEN 0 ELSE 1 END, event_id DESC LIMIT 1
       ) current_images ON true
       LEFT JOIN LATERAL (
         SELECT image.attachment_id FROM attachments image
         WHERE image.entity_type='sourcing_case' AND image.entity_id=case_view.sourcing_case_id::text
           AND image.status='ready' AND image.mime_type IN ('image/jpeg','image/png','image/webp')
           AND (current_images.ids IS NULL OR current_images.ids ? image.attachment_id::text)
         ORDER BY image.created_at,image.attachment_id LIMIT 1
       ) first_image ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(
           jsonb_build_object(
             'position',line.position,
             'styleNo',line.style_no,'formalStyleNo',line.formal_style_no,'imageAttachmentId',line.image_attachment_id,
             'alternateStyleNo',line.alternate_style_no,
             'color',line.color,
             'quantity',line.quantity,
             'externalUnitPrice',line.external_unit_price::text,
             'legacy',line.legacy_source
           )
           ORDER BY line.position
         ) AS line_items
         FROM current_sourcing_case_lines line
         WHERE line.sourcing_case_id=case_view.sourcing_case_id
       ) lines_row ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(
           jsonb_build_object(
             'position',binding.position,
             'craftId',binding.craft_id,
             'craftCode',binding.craft_code_snapshot,
             'craftVersion',binding.craft_version,
             'craftName',binding.craft_name_snapshot
           )
           ORDER BY binding.position
         ) AS crafts
         FROM sourcing_case_crafts binding
         WHERE binding.sourcing_case_id=case_view.sourcing_case_id
       ) crafts_row ON true
       LEFT JOIN LATERAL (
         SELECT quote.*
         FROM sourcing_ie_quotes quote
         WHERE quote.sourcing_case_id=case_view.sourcing_case_id
         AND (quote.quoted_at > COALESCE((SELECT max(transitioned_at) FROM sourcing_case_transitions WHERE sourcing_case_id=case_view.sourcing_case_id AND business_action='returned_to_merchandiser'), '-infinity'::timestamptz) OR (to_jsonb(quote)->>'adopted_budget_order_id' IS NOT NULL AND (SELECT business_action FROM sourcing_case_transitions WHERE sourcing_case_id=case_view.sourcing_case_id AND business_action IN ('returned_to_merchandiser','correction_retained_ie_basis') ORDER BY sequence DESC LIMIT 1)='correction_retained_ie_basis'))
         ORDER BY quote.quote_version DESC
         LIMIT 1
       ) quote_row ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'position',line.position,'quantity',line.quantity,
           'unitPrice',line.unit_price::text,'totalAmount',line.total_amount::text
         ) ORDER BY line.position) AS line_prices
         FROM sourcing_ie_quote_lines line
         WHERE line.sourcing_ie_quote_id=quote_row.sourcing_ie_quote_id
       ) quote_lines_row ON true
       LEFT JOIN sourcing_decisions decision_row ON decision_row.sourcing_decision_id=case_view.selected_decision_id
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'position',line.position,'quantity',line.quantity,
           'unitPrice',line.unit_price::text,'totalAmount',line.total_amount::text
         ) ORDER BY line.position) AS line_prices
         FROM sourcing_decision_lines line
         WHERE line.sourcing_decision_id=decision_row.sourcing_decision_id
       ) decision_lines_row ON true
       LEFT JOIN sourcing_owner_decisions owner_row
         ON owner_row.sourcing_decision_id=decision_row.sourcing_decision_id
       LEFT JOIN LATERAL (
         SELECT approval.*
         FROM sourcing_approval_snapshots approval
         WHERE approval.sourcing_case_id=case_view.sourcing_case_id
         ORDER BY approval.decision_version DESC LIMIT 1
       ) snapshot ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'position',line.position,'styleNo',line.style_no,
           'alternateStyleNo',line.alternate_style_no,'color',line.color,
           'quantity',line.quantity,'unitPrice',line.unit_price::text,
           'totalAmount',line.total_amount::text
         ) ORDER BY line.position) AS line_prices
         FROM sourcing_approval_snapshot_lines line
         WHERE line.sourcing_approval_snapshot_id=snapshot.sourcing_approval_snapshot_id
       ) snapshot_lines ON true
       )
       SELECT page_row.*,totals.total_count,totals.total_order_quantity
       FROM (
         SELECT count(*)::text AS total_count,
           COALESCE(sum(order_quantity),0)::text AS total_order_quantity
         FROM filtered_cases
       ) totals
       LEFT JOIN LATERAL (
         SELECT * FROM case_details
       ) page_row ON true
       ORDER BY page_row.created_at DESC,page_row.sourcing_case_id DESC`,
      [
        normalizedQuery,
        statusFilter,
        stage,
        gender,
        normalizedStyleName,
        contractReturn,
        offset,
        ...(ieHistory?[actor.actorId,sourcingIeHistoryAll(actor)]:[]),
      ],
    );
    const pageRows = result.rows.filter(row => row.sourcing_case_id != null);
    const totalCount = Number(result.rows[0]?.total_count ?? "0");
    await assertContractReturnCaseClocks(database,pageRows.map(row=>row.sourcing_case_id));
    const dates=await currentFactoryPagePoLines(database,pageRows.filter(row=>row.workflow_generation==='digital_production_v1').map(row=>row.sourcing_case_id));
    const items=pageRows.map(row=>{
      const item=mapCase(row,actor),positions=dates.get(row.sourcing_case_id);
      if(!positions)return item;
      return {...item,lineItems:item.lineItems.map(line=>{
        const po=positions.get(line.position);
        return po?{...line,lineId:po.line_id,customerWarehouseArrivalDate:po.customer,factoryDeliveryDate:po.factory}:line;
      })};
    });
    return {
      items,
      page,
      pageSize: SOURCING_LIST_PAGE_SIZE,
      totalCount,
      totalOrderQuantity: Number(result.rows[0]?.total_order_quantity ?? "0"),
      totalPages: Math.max(1, Math.ceil(totalCount / SOURCING_LIST_PAGE_SIZE)),
    };
}
