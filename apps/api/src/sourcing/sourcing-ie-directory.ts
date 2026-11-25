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

export function sourcingIeCandidates(actor:TrustedActorContext):IeAuthorizedCandidates['sourcing_review']{
 if(!mayReadSourcing(actor))return undefined;
 return ({bind,search})=>{
  const history=sourcingIeHistoryPredicate(bind(actor.actorId),bind(sourcingIeHistoryAll(actor)));
  return `SELECT case_view.sourcing_case_id AS object_id,case_view.sourcing_case_id AS entry_id,case_view.sourcing_case_id AS resource_id,
   case_view.erp_order_id AS order_id,case_view.style_no,NULL::text AS customer_code,case_view.version::int AS version,
   NULL::int AS round,case_view.status AS native_status,case_view.created_at AS sort_at,
   CASE WHEN case_view.status='pending_ie_quote' AND EXISTS(SELECT 1 FROM sourcing_case_transitions current_transition
      WHERE current_transition.sourcing_case_id=case_view.sourcing_case_id AND current_transition.sequence=case_view.version
        AND current_transition.business_action='correction_submitted') THEN 'returned'
    WHEN case_view.status='pending_ie_quote' THEN 'awaiting_price'
    WHEN case_view.status='pending_merchandiser_correction' THEN 'not_started' ELSE 'priced' END AS state
  FROM current_sourcing_cases case_view
  JOIN app_users creator ON creator.id=case_view.created_by
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
