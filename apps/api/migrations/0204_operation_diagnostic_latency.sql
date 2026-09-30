-- OBS-01: preserve per-operation latency without adding request, actor, payload or credential data.
ALTER TABLE work_operation_diagnostics
  ADD COLUMN duration_ms numeric(14,3)
  CHECK(duration_ms IS NULL OR duration_ms >= 0);
