/** Exact original SELECT shapes observed in the native88 pre-change trace. Unknown/changed shapes fall back to pg. */
export const JOURNEY_ORDER_BATCH_TEMPLATES=new Map<string,'uuid'|'text'>([
 // apps/api/src/production-platform/series-plan-service.ts, apps/api/src/production-platform/ship-sample-service.ts, apps/api/src/production-platform/quotation-budget-basis.ts, apps/api/src/production-platform/quotation-service.ts, apps/api/src/production-platform/sla-order-service.ts, apps/api/src/production-platform/sla-calculation-service.ts, apps/api/src/production-platform/series-plan-journey.ts, apps/api/src/production-platform/bulk-preparation-service.ts, apps/api/src/production-platform/preparation-material-repository.ts, apps/api/src/sourcing/sourcing-service.ts · SELECT * FROM digital_production_orders WHERE production_order_id=$1
 ['5aeb2a5906c49eb31fed54acb12fab1e27aa0a50d32e4c587b597c7aab2f6b0f','uuid'],
 // apps/api/src/production-platform/factory-return-logistics.ts · SELECT s.production_order_id,s.factory_decision_id,s.shipped_on::text AS shipped_on,s.operation_event_id,
 ['592cd5355e7d86e867a21a6dfaa121ce5e173cdf906db5cccf5f226e053226ce','uuid'],
 // Original native driver SQL; query-budget and exact result regressions detect shape drift · SELECT p.production_order_id,p.factory_decision_id,p.sourcing_decision_id,p.supplier_id,p.supplier_name_s
 ['0a37b0b344ed73dfc211b8e73c2af3313ae607be5606ab112ee3ffffc34afd9d','uuid'],
 // apps/api/src/production-platform/garment-quality.ts · SELECT l.line_id,r.receipt_id,r.receiving_batch_id,r.cutting_order_id,r.received_at,e.after_state,
 ['272ccaf028c499a24f6d8bd284b720b59be654572126be59f99397dffd2e5a15','uuid'],
 // apps/api/src/production-platform/receiving-forecast.ts · SELECT s.production_order_id,s.factory_decision_id,s.recorded_quantity,
 ['442241f80998df4af094f8af9d51f949d4128b283cbb8726efbf1089ec4ad168','uuid'],
 // apps/api/src/production-platform/order-closure-service.ts · SELECT l.line_id,r.receipt_id,r.received_at,e.after_state,coalesce(c.actual_quantity,r.actual_quantity) a
 ['30a9fe10b1f5dbf372fa843fcd66898b77e33c08ee484e2651f9b36332eb4b9f','uuid'],
 // apps/api/src/production-platform/ship-sample-facts.ts · SELECT f.*,u.display_name,v.order_snapshot FROM digital_factory_facts f JOIN digital_factory_routes r USI
 ['53f2db842ab857be9561862776a74191af161297466276afb9868ddd023f6f29','uuid'],
 // apps/api/src/production-platform/bulk-preparation-service.ts · SELECT po.line_id AS "lineId",po.po_number AS "poNumber",po.formal_style_no AS "formalStyleNo",po.tempora
 ['fcc094e48716c0ea897af7f65c4514b192ad9ce8864665b046b1084f87705d52','uuid'],
 // apps/api/src/production-platform/journey-query.ts · SELECT l.line_id AS id,l.po_number AS po,l.color,l.formal_style_no AS "formalStyleNo",l.temporary_style_n
 ['ff649562d26bca5ab52b617d4e8841998ac230d094cfeabfba8a300fcfcd67ee','uuid'],
 // apps/api/src/production-platform/order-closure-service.ts · SELECT l.line_id,r.*, (SELECT count(*)::int FROM rework_wage_items w WHERE w.rework_order_id=r.rework_ord
 ['d25c98168fd6b254c6a7a9ff355a8a98d4696d0a408bdef8ffe1d086ccf13b80','uuid'],
 // apps/api/src/production-platform/receiving-span.ts · SELECT DISTINCT r.receipt_id,r.received_at,r.actual_quantity,e.event_id,e.created_at,e.after_state,b.dele
 ['76e7f1d8677d6860053cf8fc56e1cf8b9bf58f90802102c1387bf3fbf30f15c7','uuid'],
 // apps/api/src/production-platform/factory-production-facts.ts · SELECT e.*,u.display_name FROM digital_production_task_events e JOIN app_users u ON u.id=e.actor_id
 ['b9a50c95b2efe9f8adbed28e4592dc215c5f8754711c3b22adeb480e361f65ef','uuid'],
 // apps/api/src/production-platform/journey-query.ts · SELECT p.preparation_id FROM digital_bulk_preparations p
 ['56e70c031bddb40a87855f6b67f9b32f93431d3b3193cc7582a16445241dbdc4','uuid'],
 // apps/api/src/production-platform/order-closure-service.ts · SELECT p.*,(SELECT sum(quantity) FROM digital_production_po_sizes WHERE line_id=p.line_id) total_quantity
 ['5037b7a724f76a9651a4f510eaeec3b7ba7c6b28af3112f91917a09a4dd406ee','uuid'],
 // apps/api/src/production-platform/order-closure-service.ts · SELECT t.task_id,t.node_key,t.state,(SELECT label FROM digital_production_deadline_policies WHERE node_ke
 ['2f14c68453e9c153b0947f3e13509bd248867b6d9f4b8a64abb0b4c859a19814','uuid'],
 // apps/api/src/production-platform/sla-applied-window.ts · SELECT e.event_id,e.payload,e.recorded_at AS application_recorded_at,s.* FROM digital_production_task_eve
 ['811e8f6285bca8a04680d02383d0dc764cbc340029795213dc3eb09828fd9c2c','uuid'],
 // apps/api/src/production-platform/factory-return-logistics.ts, apps/api/src/production-platform/sla-task-policy.ts, apps/api/src/production-platform/ship-sample-timing.ts · SELECT * FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision LIMIT 1
 ['1edbd35d8d00254c68cf0d1442e35314be1189513fade223142bfbc22e4d10d6','uuid'],
 // apps/api/src/production-platform/bulk-preparation-service.ts · SELECT s.* FROM digital_production_child_links l JOIN sourcing_cases s ON s.sourcing_case_id=l.child_id W
 ['45dd563fd7854edb30cd9619cbe6ceece2ecf32d221a2bbc891273bbe135c761','uuid'],
 // apps/api/src/production-platform/bulk-preparation-service.ts · SELECT e.event_id,e.occurred_at,e.payload,u.display_name FROM digital_production_task_events e JOIN app_u
 ['dde44dc9d1468ffc97c921ddd2a1aebe77141754f9c7f36e18e2e1a054b5e285','uuid'],
 // apps/api/src/production-platform/journey-query.ts · SELECT 1 WHERE EXISTS(SELECT 1 FROM digital_order_closures WHERE production_order_id=$1) OR EXISTS(SELECT
 ['8397bf4a8898fb5aa447c9ef6ff1a11cb360b28904d834c391efa820448514d4','uuid'],
 // apps/api/src/production-platform/ship-sample-facts.ts · SELECT e.event_id,e.occurred_at,e.payload,u.display_name FROM digital_production_task_events e JOIN app_u
 ['ed868ce806bcc6e777dc1a7dc19b85bf5d9b5a0a22d9ee7d0021ad1e7a54e6ee','uuid'],
 // apps/api/src/production-platform/preparation-material-repository.ts · SELECT line_id,color,quantity.order_quantity FROM digital_production_po_lines p CROSS JOIN LATERAL (SELEC
 ['530ba44f0f6421c7fe9cd328c15acf528edb105e0844ce917bbff7b760c481ce','uuid'],
 // apps/api/src/production-platform/order-closure-service.ts · SELECT 1 FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id) WHERE a.pro
 ['3232f20b4813acc8001b10e14fb339838b95b062d18813a97dcd68d0608f72f7','uuid'],
 // apps/api/src/production-platform/production-readiness-service.ts · SELECT r.* FROM digital_bulk_work_ranges r JOIN digital_bulk_preparations p USING(preparation_id) WHERE p
 ['fd3af006db7860b37c68c7a17bed2339d24fcdd13f482196727e8382fc81a7a3','uuid'],
 // apps/api/src/production-platform/journey-adopted-plan.ts · SELECT plan_id,snapshot_json FROM digital_series_plans WHERE production_order_id=$1 ORDER BY revision DES
 ['82474b16372834877dcc84ff473784f0bd78f2c57e5d127d4c51b29e3b9aec35','uuid'],
 // apps/api/src/production-platform/journey-query.ts · SELECT v.version,v.source_round,v.published_at,v.published_by FROM digital_instruction_documents d
 ['fecff0db48fd2df165257661c3c149cc99d4ceea641a84ca9a332ae95d207471','uuid'],
 // apps/api/src/production-platform/bulk-preparation-service.ts · SELECT v.* FROM digital_instruction_documents d JOIN digital_instruction_versions v ON v.production_order
 ['728423d7697a3b3fc338b2d70657cdb926bb2ccdc9a5a242df055abe4445302f','uuid'],
 // apps/api/src/production-platform/receiving-span.ts · SELECT after_state FROM audit_events WHERE entity_id=$1 AND action='digital_order_created' ORDER BY creat
 ['c2f60fc5e3e27f2b490a75b209449d0f8eb5e6182b6d5ab77a2d7254ccf5fb46','text'],
 // apps/api/src/production-platform/order-closure-service.ts · SELECT payload->>'receiptId' AS id FROM digital_production_task_events WHERE resource_kind='order' AND re
 ['529bf6c06ccf0a88bb64409fe9ea673d62c81d266ee38ab0edcfca1d75edec9a','uuid'],
 // apps/api/src/production-platform/order-closure-service.ts · SELECT c.*,u.display_name FROM digital_order_closures c JOIN app_users u ON u.id=c.closed_by WHERE c.prod
 ['676bbd61398e19fd18018a5b35b4921f799686291350eb76f5e4f50ede52e378','uuid'],
 // apps/api/src/production-platform/bulk-fabric-facts.ts · SELECT event_id,payload,occurred_at,actor_id,recorded_at,time_quality FROM digital_production_task_events
 ['4feef7ff5548659aa68436c4f4bc210cd965734b81e07c6a83529dafc92acd85','uuid'],
 // apps/api/src/production-platform/journey-query.ts · SELECT module,child_id FROM digital_production_child_links WHERE production_order_id=$1 ORDER BY module,c
 ['a2f7bc19209ecc3213db85086be137abf9e3635d97f74dff06f214a47ea3528c','uuid'],
 // apps/api/src/production-platform/order-closure-service.ts, apps/api/src/production-platform/factory-flow-service.ts · SELECT child_id FROM digital_production_child_links WHERE module='production' AND production_order_id=$1
 ['ae423bcc1aaf677d98e9ecac545b4bfec19066b1cf20499c37007b859381895c','uuid'],
 // apps/api/src/production-platform/series-plan-journey.ts · SELECT snapshot_json FROM digital_series_plans WHERE production_order_id=$1 ORDER BY revision DESC LIMIT 
 ['8ea2703835a962b2c2b94e5b2f79acd65c3abd3b1df38a8f5cb3b42abaf40dcf','uuid'],
 // apps/api/src/production-platform/journey-query.ts · SELECT version,status,published_at FROM digital_budget_documents WHERE production_order_id=$1
 ['b46f776889cc77b76196366e80bafd118911c4a1e0862ae625e24b0001a7f5f2','uuid'],
 // apps/api/src/production-platform/journey-query.ts · SELECT module,child_id,line_id FROM digital_production_child_lines WHERE production_order_id=$1 ORDER BY 
 ['f8e0ccf6cd90fecdacd26dd4aa51422504daa55688afda2c1b3ecb0332d68655','uuid'],
 // apps/api/src/production-platform/production-readiness-service.ts · SELECT * FROM digital_instruction_deliveries WHERE production_order_id=$1 ORDER BY recorded_at,event_id
 ['f0cdcea9d1f2705ee810d6cd6d77087af4af3fdc5efa2ec41a5a1fc475b0267b','uuid'],
 // apps/api/src/production-platform/garment-quality.ts, apps/api/src/production-platform/bulk-preparation-service.ts · SELECT snapshot_id FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision DESC L
 ['1edf065cb23610b56739d625e18f7752fcc3cbe7949091eea90eb60969e59a5c','uuid'],
 // apps/api/src/production-platform/bulk-preshrink-correction-service.ts, apps/api/src/production-platform/bulk-preparation-service.ts · SELECT * FROM digital_bulk_dispatch WHERE production_order_id=$1
 ['3d2a89f69f6b634a1ae289294211b51c15312915a7c75530a10866267d2ea7f5','uuid'],
 // apps/api/src/production-platform/sla-order-application.ts, apps/api/src/production-platform/series-plan-service.ts, apps/api/src/production-platform/po-customer-date-service.ts, apps/api/src/production-platform/preparation-todos.ts, apps/api/src/production-platform/ship-sample-service.ts, apps/api/src/production-platform/garment-quality.ts, apps/api/src/production-platform/qc-production-progress-service.ts, apps/api/src/production-platform/journey-query.ts, apps/api/src/production-platform/production-readiness-service.ts, apps/api/src/production-platform/factory-flow-service.ts, apps/api/src/production-platform/bulk-preparation-service.ts, apps/api/src/production-platform/task-service.ts · SELECT 1 FROM digital_order_closures WHERE production_order_id=$1
 ['371f71b4b17bd5c47409664d3f0b98b926b878eb0097b0e65f6f4a483b218d71','uuid'],
 // apps/api/src/production-platform/factory-flow-service.ts, apps/api/src/production-platform/series-plan-journey.ts, apps/api/src/production-platform/preparation-material-repository.ts · SELECT warehouse_worker_id FROM digital_bulk_dispatch WHERE production_order_id=$1
 ['fd5395c2f6d64c8f9a636de5585b1067d296d94b2d100a17ebab63b44e56dd02','uuid'],
 // apps/api/src/production-platform/journey-query.ts · SELECT v.document->'images' AS images FROM digital_instruction_documents d JOIN digital_instruction_versi
 ['4836e4832104412297c3193ded456b7389f5754560a320cf0f0a59c3de6105bd','uuid'],
]);
