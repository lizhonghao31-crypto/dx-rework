-- Existing history stays immutable. Only new sewing-result uploads carry a task identity.
ALTER TABLE digital_development_upload_purposes
 DROP CONSTRAINT digital_development_upload_purposes_purpose_check,
 ADD COLUMN task_id uuid REFERENCES digital_production_tasks(task_id),
 ADD CONSTRAINT digital_development_upload_purposes_purpose_check CHECK(purpose IN ('工艺开发板','面料报告','车板成果')),
 ADD CONSTRAINT digital_development_upload_task_check CHECK((purpose='车板成果')=(task_id IS NOT NULL));
