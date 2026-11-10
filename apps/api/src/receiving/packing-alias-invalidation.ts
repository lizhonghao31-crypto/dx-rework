import type {PoolClient} from 'pg';
/** Names are uncertainty candidates only, never a PO/receipt allocation. A
 * legacy source appearing/disappearing can invalidate a previously proved
 * native empty scope. Register in the original business transaction; rebuilding
 * remains the existing bounded worker's responsibility. */
export async function invalidatePackingAliasCandidates(db:Pick<PoolClient,'query'>,styles:readonly string[]){
 const names=[...new Set(styles.map(value=>value.trim().toUpperCase()).filter(Boolean))];
 if(!names.length||!(await db.query("SELECT to_regclass('digital_journey_fact_changes') AS changes")).rows[0]?.changes)return;
 await db.query(`INSERT INTO digital_journey_fact_changes(resource_kind,resource_id)
  SELECT DISTINCT 'order',o.production_order_id FROM digital_production_orders o JOIN digital_production_po_lines p USING(production_order_id)
  WHERE NOT EXISTS(SELECT 1 FROM digital_production_child_links child WHERE child.production_order_id=o.production_order_id AND child.module IN ('sourcing','cutting','receiving','production'))
  AND (EXISTS(SELECT 1 FROM unnest(ARRAY[p.po_number,p.formal_style_no,p.temporary_style_no,o.design_style_no,o.temporary_style_no]) alias(value) WHERE upper(btrim(alias.value))=ANY($1::text[]))
   OR EXISTS(SELECT 1 FROM audit_events creation WHERE creation.action='digital_order_created' AND creation.entity_type='digital_production' AND creation.entity_id=o.production_order_id::text
    AND EXISTS(SELECT 1 FROM unnest(ARRAY[creation.after_state->'lines'->(p.position-1)->>'formalPoNo',creation.after_state->'lines'->(p.position-1)->>'formalStyleNo',creation.after_state->'lines'->(p.position-1)->>'poNumber',creation.after_state->'lines'->(p.position-1)->>'temporaryStyleNo']) alias(value) WHERE upper(btrim(alias.value))=ANY($1::text[]))))
  ON CONFLICT DO NOTHING`,[names]);
}
