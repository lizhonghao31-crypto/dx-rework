import type {IeAuthorizedCandidates} from '../production-platform/ie-authorized-directory.js';
import {isRootActor} from '../access/business-authority.js';
import type {TrustedActorContext} from '../tools/repositories.js';

export const sourcingReadCapability='sourcing:view';
export function mayReadSourcing(actor:TrustedActorContext){
 return actor.authorizationCapability===sourcingReadCapability&&(isRootActor(actor)
  ||(actor.authorizationCapabilities??[]).includes(sourcingReadCapability));
}

export const sourcingIeHistoryAll=(actor:TrustedActorContext)=>
 actor.actorRoles.some(role=>role==='root_superuser'||role==='production_management'||role==='owner_group');

/** Keep exactly the existing history scope when adapting the old IE queue. */
export const sourcingIeHistoryPredicate=(actor:string,canReadAll:string)=>`(case_view.status<>'pending_ie_quote' AND EXISTS (
 SELECT 1 FROM sourcing_ie_quotes history_quote WHERE history_quote.sourcing_case_id=case_view.sourcing_case_id
  AND (${canReadAll}::boolean OR history_quote.quoted_by=${actor}::uuid)
))`;

/** The original quote timestamp is never refreshed when a correction retains its adopted basis.
 * A subsequent return makes it ineffective again until that correction is completed. */
export const currentSourcingIePricePredicate=`(quote.quoted_at>COALESCE((SELECT max(transitioned_at)
 FROM sourcing_case_transitions WHERE sourcing_case_id=case_view.sourcing_case_id AND business_action='returned_to_merchandiser'),'-infinity'::timestamptz)
 OR (to_jsonb(quote)->>'adopted_budget_order_id' IS NOT NULL AND (SELECT business_action FROM sourcing_case_transitions
 WHERE sourcing_case_id=case_view.sourcing_case_id AND business_action IN ('returned_to_merchandiser','correction_retained_ie_basis')
 ORDER BY sequence DESC LIMIT 1)='correction_retained_ie_basis'))`;

export function sourcingIeCandidates(actor:TrustedActorContext):IeAuthorizedCandidates['sourcing_review']{
 if(!mayReadSourcing(actor))return undefined;
 return ({bind,search})=>{
  const actorId=bind(actor.actorId),readAll=bind(sourcingIeHistoryAll(actor));
  const history=sourcingIeHistoryPredicate(actorId,readAll);
  return `SELECT case_view.sourcing_case_id AS object_id,case_view.sourcing_case_id AS entry_id,case_view.sourcing_case_id AS resource_id,
   case_view.erp_order_id AS order_id,case_view.style_no,NULL::text AS customer_code,case_view.version::int AS version,
   NULL::int AS round,case_view.status AS native_status,case_view.created_at AS sort_at,
   owner.display_name AS assignee_name,
   CASE WHEN adopted.sourcing_ie_quote_id IS NULL THEN NULL
    WHEN price.facts>1 THEN json_build_object('kind','multiple')
    ELSE json_build_object('kind','single','amount',coalesce(price.unit_price,adopted.unit_price)::text,'unit','件') END AS pricing,
   CASE WHEN case_view.status='pending_ie_quote' AND EXISTS(SELECT 1 FROM sourcing_case_transitions current_transition
      WHERE current_transition.sourcing_case_id=case_view.sourcing_case_id AND current_transition.sequence=case_view.version
        AND current_transition.business_action='correction_submitted') THEN 'returned'
    WHEN case_view.status='pending_ie_quote' THEN 'awaiting_price'
    WHEN case_view.status='pending_merchandiser_correction' THEN 'not_started' ELSE 'priced' END AS state
  FROM current_sourcing_cases case_view
  JOIN app_users creator ON creator.id=case_view.created_by
  LEFT JOIN LATERAL (SELECT quote.sourcing_ie_quote_id,quote.quoted_by,quote.unit_price FROM sourcing_ie_quotes quote
    WHERE quote.sourcing_case_id=case_view.sourcing_case_id AND ${currentSourcingIePricePredicate}
    ORDER BY quote.quote_version DESC LIMIT 1) current_price ON case_view.status<>'pending_ie_quote'
  LEFT JOIN sourcing_ie_quotes adopted ON adopted.sourcing_ie_quote_id=current_price.sourcing_ie_quote_id
    AND (${readAll}::boolean OR adopted.quoted_by=${actorId}::uuid)
  LEFT JOIN app_users owner ON owner.id=adopted.quoted_by
  LEFT JOIN LATERAL (SELECT count(DISTINCT lines.unit_price) facts,min(lines.unit_price) unit_price FROM sourcing_ie_quote_lines lines
    WHERE lines.sourcing_ie_quote_id=adopted.sourcing_ie_quote_id) price ON true
  WHERE (case_view.status='pending_ie_quote' OR ${history})
   AND (${search}::text='' OR position(lower(${search}) in lower(case_view.erp_order_id))>0
    OR position(lower(${search}) in lower(case_view.erp_order_no))>0
    OR position(lower(${search}) in lower(case_view.style_no))>0
    OR EXISTS(SELECT 1 FROM sourcing_style_aliases alias WHERE alias.sourcing_case_id=case_view.sourcing_case_id
      AND position(lower(${search}) in lower(alias.style_no))>0)
    OR EXISTS(SELECT 1 FROM current_sourcing_case_lines line WHERE line.sourcing_case_id=case_view.sourcing_case_id
      AND (position(lower(${search}) in lower(line.formal_style_no))>0 OR position(lower(${search}) in lower(line.style_no))>0)))`;
 };
}
