// Historical schema-1 publications create a standalone shipping task. Match
// only that original first-round task, not a physical successor, a newer
// frozen workbench route, or a later revision. Both reads and writes use it.
export const legacyIndependentShippingSql = `(
 a.task_kind='development_shipping' AND t.route_version=1
 AND (SELECT coalesce(to_jsonb(p)->>'route_schema_version','1') FROM digital_development_sla_plans p
   WHERE p.source_id=a.source_id ORDER BY p.revision DESC LIMIT 1)='1'
 AND NOT EXISTS (SELECT 1 FROM digital_production_task_dependencies dep WHERE dep.task_id=t.task_id)
 AND NOT EXISTS (SELECT 1 FROM digital_production_tasks peer WHERE peer.route_instance_id=t.route_instance_id AND peer.task_id<>t.task_id)
)`;
