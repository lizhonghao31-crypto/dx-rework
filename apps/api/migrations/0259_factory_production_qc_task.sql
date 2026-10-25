-- Reuse task access, original immutable task events and existing assignment/notification machinery.
-- Inspection completion is a business fact, not a quality-release or shipment flag.
INSERT INTO digital_production_deadline_policies(node_key,version,label,sla_seconds,warning_ratio)
 VALUES('factory_production_qc',1,'工厂成衣QC检查',NULL,0.7);
