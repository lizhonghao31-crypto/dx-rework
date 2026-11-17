# SLA/Journey source selection, 2026-11-17

Base: 8f257c24c7a0b131c4290611205c633ea1f0a142. Static implementation only; no tests or benchmark executed.

## Enabled decision
The exact 25 runtime paths and 26 supporting files declared in full-gate-risk-map are a reviewed family, not a directory wildcard. A diff must include a runtime path, every path must exist and belong to the family. Unknown/new/deleted paths, other business domains, auth/access, shared contracts/index, tools/repositories, errors, migration/manifest, schema helpers, lockfiles, workflow or selector modifications invalidate this exception.

For this family, retain all 32 original RP2 mapped suites and 17 chain bridges. Set CHAIN_PROFILE=sla-journey-v1 while BUSINESS_CHAIN_SENSITIVE remains true. Do not skip the business-chain receipt check or OSS runtime validation. Root audit rules for actual migrations stay unchanged. PG13 remains separate where required by the existing classifier.

The historical #1013 set was 32 mapped + 21 chain - 3 overlaps = 50. This exact source family yields 32 + 17 - 3 = 46 configured entries by set construction. This is not a measured timing result. The CI-governance implementation itself contains selector/AGENTS changes and therefore still uses the full conservative policy.

## Four audited omissions from the chain supplement
- own-tail-responsibility-history: isolated historical schema and manifest migrations through 0165; cases use SQL/pg/node rather than the changed Journey/SLA implementation. Migration, manifest, schema-helper or its own test changes cancel this exception.
- sample-foundation: isolated sample schema; fixed foundation/sample migrations and sample-migration staging. Runtime imports are node/zod, tools repositories, business-authority and errors, not Journey/SLA.
- sample-read (including sample-analysis cases): isolated sample tables and fixed sample migrations; SampleReadService/AnalysisService use sample contracts and sample-authority. The analysis cases explicitly use sample-analysis service and migration 0160. Neither invokes changed Journey/SLA facts.
- sample-create: isolated sample schema, fixed sample migrations plus the employee-directory table; SampleCreateService/AttachmentService use sample contracts/authority/migration, tools repositories and errors. No changed Journey/SLA consumer.

Transitive checks: tools/repositories uses acceptance-clock/business-time, platform/errors and sanitizeOperationalError from domain root. The root domain module does not export digital-sla-plan. The contracts root exports samples/sample-read/create/workflow and other legacy schemas, not digital-production-journey. Business-authority imports export-authority/errors; auth/root references are type-only. None of these shared runtime files is eligible for the profile. No sampled business state or mutable identity is reused.

## All retained chain entries
- qc-progress-retirement
- production-readiness
- full-business-chain
- customer-quotation
- development-technical
- series-plan
- root-single-account-two-pass
- receiving
- rework-v2-n01
- rework-v2-process-worker-preassignment
- sourcing-pr03
- production-closure
- sample-workflow
- sample-disposal
- sample-import
- acceptance-role-session
- acceptance-worker-people

Production-readiness/development-technical/sourcing are direct mapped consumers. Full-business-chain and Root retain complete integration/security boundaries. QC, series and the remaining legacy operations retain conservative bridges. Sample workflow/disposal/import call TodoService and RootAwareTodoProjectionService and are NOT assumed independent merely because their names contain sample. Session/worker security suites stay.

All original 32 mapped tests remain, including native clocks, fixed schedule, packing, development/craft, fact repository/update, SQL-budget performance, original authenticated browsers and PG13 requirements. No SQL-budget threshold or assertion changed.

## One plan, one receipt
Classifier emits CHAIN_PROFILE; scopeFor carries chain_profile; full-gate-lanes derives and restores the same environment. test-suite-plan constructs the actual chain subset. Existing complete-plan execution fingerprints and aggregate/final scope recomputation bind this decision; no second plan source or arbitrary omit list. Unknown profiles and migration/deployment/not-required contradictions reject. Directly mapped excluded suites are never removed from mapped.

## References and applied lessons
- Airflow 5a846fd1 selective_checks.py: explicit file groups and dependent test categories. Applied as a bounded source family and explicit cross-domain bridge set, not a general backend shortcut.
- Airflow 5a846fd1 import_graph.py: shared/dynamic/unknown dependencies prevent narrowing. Applied by keeping unknown paths and shared infrastructure outside the exception; no claim of a complete automatic graph.
- Medusa 542caefc action.yml/package.json: explicit package test groups. Applied as named groups in the canonical plan. No copied matrices, worker increase, empty-pass option or extra runner.
Links:
https://github.com/apache/airflow/blob/5a846fd1a8e29dc09ba3ef50c6fab1072a609451/dev/breeze/src/airflow_breeze/utils/selective_checks.py
https://github.com/apache/airflow/blob/5a846fd1a8e29dc09ba3ef50c6fab1072a609451/dev/breeze/src/airflow_breeze/utils/import_graph.py
https://github.com/medusajs/medusa/blob/542caefc231959d2f98fefcea4291521b9aef94a/package.json
