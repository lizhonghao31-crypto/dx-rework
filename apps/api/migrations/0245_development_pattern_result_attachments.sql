-- Preserve legacy purposes; new paper results are scoped to an exact task.
ALTER TABLE digital_development_upload_purposes
 DROP CONSTRAINT digital_development_upload_purposes_purpose_check,
 DROP CONSTRAINT digital_development_upload_task_check,
 ADD CONSTRAINT digital_development_upload_purposes_purpose_check CHECK(purpose IN ('工艺开发板','面料报告','车板成果','纸样成果')),
 ADD CONSTRAINT digital_development_upload_task_check CHECK((purpose IN ('车板成果','纸样成果'))=(task_id IS NOT NULL));
