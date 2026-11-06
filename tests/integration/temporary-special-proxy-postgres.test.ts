import {vi as correctnessBudget} from 'vitest';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
// Scoped to this heavy PG correctness file; global ordinary/performance defaults stay strict.
correctnessBudget.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { SaveProcessConfigurationSchema } from "@dx-rework/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WorkerAwareAccessMasterDataService } from "../../apps/api/src/access/worker-aware-access-service.js";
import { ProcessConfigurationService } from "../../apps/api/src/rework/process-configuration-service.js";
import { ProcessWorkerPlanService } from "../../apps/api/src/rework/process-worker-plan-service.js";
import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import { ReworkV2SubmissionService } from "../../apps/api/src/rework/v2-submission-service.js";
import { WholeOrderReviewService } from "../../apps/api/src/rework/whole-order-review-service.js";
import { WorkReportingService } from "../../apps/api/src/rework/work-reporting-service.js";
import { OperationEventRepository, type TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import { completeInspectionReport } from "../inspection-report-fixture.js";
import {ownedPostgresSchema,createOwnedPostgresSchema,releaseOwnedPostgresSchema} from "../helpers/owned-postgres-schema.js";
import {assertTestDatabaseTarget} from '../../scripts/test-database-safety.mjs';
import {applyMigrations} from '../../scripts/migration-lib.mjs';
import {migrationExecutionSql} from '../../scripts/deploy/migration-execution-compatibility.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const migrationVersion = "0231_temporary_special_process_proxy_reporting";

run("temporary special-process proxy reporting through main230, hotfix and complete release integration", () => {
  const schema = ownedPostgresSchema("temporary_proxy");
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const database = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const access = new WorkerAwareAccessMasterDataService(database, "corp");
  const initiation = new ReworkInitiationService(database, "corp");
  const submission = new ReworkV2SubmissionService(database, "corp");
  const configuration = new ProcessConfigurationService(database);
  const plan = new ProcessWorkerPlanService(database);
  const reporting = new WorkReportingService(database);
  const review = new WholeOrderReviewService(database);
  const events = new OperationEventRepository();
  const ids = Object.fromEntries(["root", "tail", "qc", "ie", "worker", "other", "delegate", "blocked", "owner"].map(key => [key, randomUUID()])) as Record<"root" | "tail" | "qc" | "ie" | "worker" | "other" | "delegate" | "blocked" | "owner", string>;
  let workerPersonId: string;
  let hotfixSql: string;
  let historyBefore: unknown[];
  let releaseManifest:Array<{version:string;checksum:string}>;
  let upgraded = false;
  let scopedUrl:string;

  const effectiveGuard=async()=>{
    for(const name of ['guard_rework_work_report_insert','rework_work_report_actor_authorized']){
      const body=hotfixSql.match(new RegExp(`CREATE(?: OR REPLACE)? FUNCTION ${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`))?.[1];
      expect(body).toBeDefined();
      const signature=name==='guard_rework_work_report_insert'?`${name}()`:`${name}(uuid,text,uuid)`;
      const row=(await database.query('SELECT prosrc,prosecdef,provolatile FROM pg_proc WHERE oid=$1::regprocedure',[signature])).rows[0];
      expect(row.prosrc).toBe(body);expect(row.prosecdef).toBe(false);expect(row.provolatile).toBe(name==='guard_rework_work_report_insert'?'v':'s');
    }
    expect((await database.query("SELECT tgfoid='guard_rework_work_report_insert()'::regprocedure AS exact,tgenabled FROM pg_trigger WHERE tgrelid='rework_work_reports'::regclass AND tgname='rework_work_reports_guard_insert'")).rows).toEqual([{exact:true,tgenabled:'O'}]);
  };

  const actor = async (id: string, cap: string, ...caps: string[]): Promise<TrustedActorContext> => ({
    actorId: id,
    actorRoles: (await database.query<{ roles: string[] }>("SELECT access_authorized_actor_roles($1,$2) roles", [id, cap])).rows[0]!.roles,
    authorizationCapability: cap,
    authorizationCapabilities: [cap, ...caps],
    requestId: randomUUID(),
  });
  const root = (cap = "master_data:manage") => actor(ids.root, cap);
  const tail = () => actor(ids.tail, "work:assign", "work:report_for_worker");

  beforeAll(async () => {
    await assertTestDatabaseTarget(databaseUrl!);
    const scoped=new URL(databaseUrl!);scoped.searchParams.set('options',`-c search_path=${schema}`);scopedUrl=scoped.toString();
    await createOwnedPostgresSchema(admin,schema);
    const identity = (await database.query("SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user")).rows[0];
    expect(Object.values(identity)).toEqual([false, false, false, false]);
    const manifest = JSON.parse(await readFile(new URL("../../apps/api/src/platform/migration-manifest.json", import.meta.url), "utf8")) as { migrations: Array<{ version: string; checksum: string }> };
    releaseManifest=manifest.migrations;expect(new Set(releaseManifest.map(row=>row.version)).size).toBe(releaseManifest.length);expect(releaseManifest.some(row=>row.version===migrationVersion)).toBe(true);
    const branches=JSON.parse(await readFile('scripts/migration-branches.json','utf8')),extensions=JSON.parse(await readFile('scripts/migration-main-extensions.json','utf8')) as Array<{version:string}>;
    const mainNames=new Set([...branches.main,...extensions].map((row:{version:string})=>row.version));
    const main230=manifest.migrations.filter(row=>row.version!==migrationVersion&&(Number(row.version.slice(0,4))<=217||mainNames.has(row.version)&&Number(row.version.slice(0,4))<=230));
    expect(main230).toHaveLength(230);expect(main230.at(-1)?.version).toBe('0230_sourcing_factory_change_current_quantity');
    await database.query("CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    for (const migration of manifest.migrations) {
      const sql = await readFile(new URL(`../../apps/api/migrations/${migration.version}.sql`, import.meta.url), "utf8");
      expect(createHash("sha256").update(sql).digest("hex")).toBe(migration.checksum);
      if (migration.version === migrationVersion) { hotfixSql = sql; continue; }
      if(!main230.some(row=>row.version===migration.version))continue;
      await database.query(migrationExecutionSql({...migration,sql},Number((await database.query('SHOW server_version_num')).rows[0].server_version_num)));
      await database.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)", [migration.version, migration.checksum]);
    }
    historyBefore = (await database.query("SELECT version,checksum,applied_at::text AS applied_at FROM schema_migrations ORDER BY version")).rows;
    expect((historyBefore.at(-1) as { version: string }).version).toBe("0230_sourcing_factory_change_current_quantity");
    for (const [key, id] of Object.entries(ids)) {
      await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)", [id, `test-proxy-${key}`]);
      await database.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','corp',$3,$3,true,true,CURRENT_TIMESTAMP)", [randomUUID(), id, `ding-${id}`]);
    }
    await access.ensureOrganizationPolicy();
    await database.query("INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id) VALUES(true,$1,$2,'corp')", [ids.root, `ding-${ids.root}`]);
    const grants = { tail: "tail_supervisor", qc: "quality_control", ie: "ie_reviewer", worker: "worker", other: "worker", delegate: "warehouse_receiver", blocked: "owner_group", owner: "owner_group" } as const;
    for (const [key, roleCode] of Object.entries(grants)) {
      const rootActor = await root("access:admin");
      // The existing Root route supplies its explicit owner acting role for
      // protected owner-group grants; this is not a real role assignment.
      const grantActor = roleCode === "owner_group" ? { ...rootActor, actorRoles: [...rootActor.actorRoles, "owner_group"] } : rootActor;
      await access.assignRole(grantActor, { userId: ids[key as keyof typeof ids], roleCode, reason: "isolated proxy regression role" });
    }
    await access.assignRole(await root("access:admin"), { userId: ids.owner, roleCode: "order_merchandiser", reason: "isolated order merchandiser" });
    const people = await access.listPeople({ includeInactive: true });
    workerPersonId = people.find(p => p.appUserId === ids.worker)!.personId;
  }, testExecutionConfig.correctnessTimeoutMs);

  afterAll(async () => {
    await database.end();
    await releaseOwnedPostgresSchema(admin,schema);
    await admin.end();
  });

  const activate = async (mode: "inspection" | "other_craft" = "inspection", formal = false) => {
    const personId = formal ? workerPersonId : (await access.createPerson(await root(), { personType: "temporary", displayName: `test-temporary-${randomUUID()}`, aliases: [], reason: "isolated temporary snapshot" })).personId;
    const style = `test-proxy-${randomUUID()}`;
    const batch = randomUUID();
    await database.query("INSERT INTO receiving_batches(receiving_batch_id,style_no,created_by,delivery_note_quantity,document_quantity_adjustment,actual_quantity_adjustment) VALUES($1,$2,$3,200,200,200)", [batch, style, ids.tail]);
    const attachmentId = randomUUID();
    await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'proxy.webp','image/webp',10,$3,$4,'ready',CURRENT_TIMESTAMP)", [attachmentId, `private/${attachmentId}.webp`, "a".repeat(64), ids.qc]);
    const draft = await initiation.createDraft(await actor(ids.qc, "rework:initiate"), {
      receivingBatchId: batch, styleNo: style, orderNo: style, orderQuantity: 200,
      merchandiserUserId: ids.owner, processingFactory: { type: "own_factory" },
      problemPart: "袖口", problemDescription: "isolated temporary proxy reporting", reworkQuantity: 200,
      tailInspectionRequired: true, specialProcessType: mode,
      ...(mode === "other_craft" ? { otherCraftDescription: "返烫领" } : {}),
      tailInspectionCostBearer: "own_factory", inspectionReport: completeInspectionReport(), attachmentIds: [attachmentId],
    }, randomUUID());
    const id = draft.value.reworkOrderId;
    const submitted = await submission.submit(await actor(ids.qc, "rework:initiate"), id, { expectedVersion: draft.value.version }, randomUUID());
    const saved = await configuration.saveDraft(await actor(ids.tail, "process:configure"), id, SaveProcessConfigurationSchema.parse({
      expectedOrderVersion: submitted.value.version,
      items: [
        { source: "custom", customProcessName: "普通返工", executionKind: "worker", plannedQuantity: 1, pricingUnit: "piece", unitPrice: 0.1 },
        { source: "custom", customProcessName: mode === "inspection" ? "整查" : "返烫领", executionKind: "tail_inspection", plannedQuantity: 1, pricingUnit: "piece", unitPrice: 0.4 },
      ],
    }), randomUUID());
    const config = saved.value.configuration!;
    await plan.save(await tail(), id, { expectedOrderVersion: saved.value.orderVersion, configurationId: config.configurationId, expectedConfigurationVersion: config.configurationVersion, assignments: config.items.map(item => ({ configurationItemId: item.configurationItemId, memberIds: [personId] })) }, randomUUID());
    const queued = await configuration.submit(await actor(ids.tail, "process:configure"), id, { expectedOrderVersion: saved.value.orderVersion, expectedConfigurationVersion: config.configurationVersion }, randomUUID());
    const approved = await configuration.review(await actor(ids.ie, "process:review"), id, { expectedOrderVersion: queued.value.orderVersion, expectedConfigurationVersion: queued.value.configuration!.configurationVersion, decision: "approved" }, randomUUID());
    await plan.activateAfterIeApproval(id, approved.value.configuration!.configurationVersion, randomUUID());
    return { id, personId, data: await reporting.list(await tail(), id) };
  };
  const payload = (data: Awaited<ReturnType<typeof reporting.list>>, quantity = 140) => ({ expectedOrderVersion: data.orderVersion, reports: data.tasks.map(task => ({ workTaskId: task.workTaskId, actualQuantity: quantity })) });
  const facts = async (id: string) => ({
    order: (await database.query("SELECT status,version FROM rework_orders WHERE rework_order_id=$1", [id])).rows,
    reports: (await database.query("SELECT * FROM rework_work_reports WHERE rework_order_id=$1 ORDER BY work_report_id", [id])).rows,
    shares: (await database.query("SELECT s.* FROM rework_work_report_member_shares s JOIN rework_work_reports r USING(work_report_id) WHERE r.rework_order_id=$1 ORDER BY s.work_report_id,s.person_id", [id])).rows,
    events: (await database.query("SELECT event_id FROM operation_events WHERE entity_id=$1 AND action='rework.work_report.submit' ORDER BY event_id", [id])).rows,
  });
  const rawReport = async (
    who: TrustedActorContext,
    f: Awaited<ReturnType<typeof activate>>,
    options: { wrongRequest?: boolean; submittedBy?: string; eventOrderId?: string; taskId?: string } = {},
  ) => {
    const task = f.data.tasks.find(t => t.executionKind === "tail_inspection")!;
    const reportId = randomUUID(), client = await database.connect();
    try {
      await client.query("BEGIN");
      const eventId = await events.append(client, who, { action: "rework.work_report.submit", entityType: "rework_order", entityId: options.eventOrderId ?? f.id, after: { workReportId: reportId, workTaskId: task.workTaskId, actualQuantity: 140 } });
      await client.query("SELECT set_config('dx_rework.work_event_id',$1,true),set_config('dx_rework.work_request_id',$2,true)", [eventId, options.wrongRequest ? randomUUID() : who.requestId]);
      await client.query("INSERT INTO rework_work_reports(work_report_id,work_task_id,rework_order_id,configuration_item_id,actual_quantity,completed_at,group_amount,submitted_by) VALUES($1,$2,$3,$4,140,CURRENT_TIMESTAMP,0,$5)", [reportId, options.taskId ?? task.workTaskId, f.id, task.configurationItemId, options.submittedBy ?? who.actorId]);
    } finally { await client.query("ROLLBACK"); client.release(); }
  };

  it("reproduces the 0230 mixed-batch failure, upgrades without rewriting history or business facts, then reports exactly once", async () => {
    const f = await activate("other_craft");
    const before = await facts(f.id);
    const request = payload(f.data);
    const who = await tail();
    const key = randomUUID();
    await expect(reporting.submitReportsBatch(who, f.id, request, key)).rejects.toMatchObject({ code: "55000" });
    expect(await facts(f.id)).toEqual(before);
    const checksum = createHash("sha256").update(hotfixSql).digest("hex");
    const client = await database.connect();
    try {
      await client.query("BEGIN"); await client.query(hotfixSql);
      await client.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)", [migrationVersion, checksum]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    expect((await database.query("SELECT version,checksum,applied_at::text AS applied_at FROM schema_migrations WHERE version<>$1 ORDER BY version", [migrationVersion])).rows).toEqual(historyBefore);
    expect(await facts(f.id)).toEqual(before);
    const first = await reporting.submitReportsBatch(who, f.id, request, key);
    expect(first.value.reworkStatus).toBe("pending_order_review");
    const committed = await facts(f.id);
    expect(committed.reports).toHaveLength(2);
    expect(committed.shares).toHaveLength(2);
    expect(committed.events).toHaveLength(2);
    const replay = await reporting.submitReportsBatch(who, f.id, request, key);
    expect(replay.reused).toBe(true);
    expect(replay.value).toEqual(first.value);
    expect(await facts(f.id)).toEqual(committed);
    expect(committed.reports.every(r => Number(r.group_amount) === 0 && r.settlement_quantity === null)).toBe(true);
    // Upgrade the genuine main231 state, including successful reports, through
    // every release migration before the remaining original security cases.
    const beforeIntegration=(await database.query('SELECT version,checksum,applied_at::text AS applied_at FROM schema_migrations ORDER BY version')).rows;
    const result=await applyMigrations(scopedUrl);expect(result.currentVersion).toBe(releaseManifest.at(-1)!.version);
    const integrated=(await database.query('SELECT version,checksum,applied_at::text AS applied_at FROM schema_migrations ORDER BY version')).rows;
    expect(integrated.map(row=>({version:row.version,checksum:row.checksum}))).toEqual(releaseManifest);for(const row of beforeIntegration)expect(integrated.find(r=>r.version===row.version)).toEqual(row);
    expect(await facts(f.id)).toEqual(committed);await effectiveGuard();expect((await applyMigrations(scopedUrl)).applied).toEqual([]);upgraded=true;
  });

  it.each(["inspection", "other_craft"] as const)("allows a deactivated temporary member's assigned %s task, but excludes them from new assignments", async mode => {
    expect(upgraded).toBe(true);
    const f = await activate(mode);
    await access.deactivatePerson(await root(), f.personId, "test historical assignment remains reportable");
    expect((await reporting.listAssignablePeople(await tail())).some(p => p.personId === f.personId)).toBe(false);
    const newTask = f.data.tasks[0]!;
    await expect(reporting.addActiveTaskMembers(await actor(ids.tail, "work:assignment_adjust"), f.id, { expectedOrderVersion: f.data.orderVersion, configurationItemId: newTask.configurationItemId, memberIds: [f.personId] }, randomUUID())).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const result = await reporting.submitReportsBatch(await tail(), f.id, payload(f.data), randomUUID());
    expect(result.value.reworkStatus).toBe("pending_order_review");
    expect((await facts(f.id)).reports).toHaveLength(2);
  });

  it("submits individual ordinary and special proxy reports through the single-report service", async () => {
    const f = await activate("other_craft");
    for (const task of [...f.data.tasks].sort((a, b) => a.executionKind === b.executionKind ? 0 : a.executionKind === "worker" ? -1 : 1)) {
      const current = await reporting.list(await tail(), f.id);
      const result = await reporting.submitReport(await tail(), task.workTaskId, { expectedOrderVersion: current.orderVersion, actualQuantity: 140 }, randomUUID());
      expect(result.value.actualQuantity).toBe(140);
    }
    expect((await reporting.list(await tail(), f.id)).reworkStatus).toBe("pending_order_review");
    expect((await facts(f.id)).reports).toHaveLength(2);
  });

  it("retains ordinary workers' own mixed reporting and Root proxy reporting for internal personnel", async () => {
    for (const rootProxy of [false, true]) {
      const f = await activate("inspection", true);
      const who = rootProxy ? await actor(ids.root, "work:report_for_worker", "tail_inspection:report") : await actor(ids.worker, "work:report", "tail_inspection:report");
      expect((await reporting.submitReportsBatch(who, f.id, payload(f.data), randomUUID())).value.reworkStatus).toBe("pending_order_review");
    }
  });

  it("does not let a supervisor proxy-report purely formal tasks or a worker report another person's tasks", async () => {
    const f = await activate("inspection", true), before = await facts(f.id);
    await expect(reporting.submitReportsBatch(await tail(), f.id, payload(f.data), randomUUID())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(reporting.submitReportsBatch(await actor(ids.other, "work:report", "tail_inspection:report"), f.id, payload(f.data), randomUUID())).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await facts(f.id)).toEqual(before);
  });

  it("keeps quantity limits and stale order versions atomic", async () => {
    const f = await activate(), before = await facts(f.id);
    await expect(reporting.submitReportsBatch(await tail(), f.id, payload(f.data, 201), randomUUID())).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(reporting.submitReportsBatch(await tail(), f.id, { ...payload(f.data), expectedOrderVersion: f.data.orderVersion - 1 }, randomUUID())).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await facts(f.id)).toEqual(before);
  });

  it("rolls back audit, reports, shares and order state after a real database rejection in a mixed batch", async () => {
    const f = await activate(), before = await facts(f.id);
    // A test-only CHECK models a downstream database failure after audit
    // insertion. No production guard is disabled or replaced.
    await database.query("ALTER TABLE rework_work_reports ADD CONSTRAINT proxy_atomic_failure_probe CHECK(actual_quantity<>137)");
    const request = payload(f.data);
    request.reports[1]!.actualQuantity = 137;
    const who = await tail(), key = randomUUID();
    try {
      await expect(reporting.submitReportsBatch(who, f.id, request, key)).rejects.toMatchObject({ code: "23514" });
      expect(await facts(f.id)).toEqual(before);
    } finally { await database.query("ALTER TABLE rework_work_reports DROP CONSTRAINT proxy_atomic_failure_probe"); }
    // The failed transaction did not consume the idempotency key.
    expect((await reporting.submitReportsBatch(who, f.id, request, key)).reused).toBe(false);
  });

  it("enforces actor, request, order and task audit binding in the database", async () => {
    const f = await activate(), who = await actor(ids.tail, "work:report_for_worker"), before = await facts(f.id);
    for (const mismatch of [{ wrongRequest: true }, { submittedBy: ids.other }, { eventOrderId: randomUUID() }, { taskId: f.data.tasks.find(t => t.executionKind === "worker")!.workTaskId }]) {
      await expect(rawReport(who, f, mismatch)).rejects.toMatchObject({ code: "55000" });
    }
    await expect(rawReport(who, f)).resolves.toBeUndefined();
    expect(await facts(f.id)).toEqual(before);
  });

  it("rejects forged proxy authority and direct database proxy inserts for formal members", async () => {
    const temporary = await activate(), formal = await activate("inspection", true);
    const forged: TrustedActorContext = { actorId: ids.other, actorRoles: ["worker"], authorizationCapability: "work:report_for_worker", authorizationCapabilities: ["work:report_for_worker"], requestId: randomUUID() };
    await expect(rawReport(forged, temporary)).rejects.toMatchObject({ code: "42501" });
    await expect(rawReport(await actor(ids.tail, "work:report_for_worker"), formal)).rejects.toMatchObject({ code: "55000" });
    await expect(rawReport(await actor(ids.other, "tail_inspection:report"), formal)).rejects.toMatchObject({ code: "55000" });
  });

  it("admits an effective global proxy delegation and rejects its stale actor context after revocation", async () => {
    const delegation = await access.createDelegation(await root("delegation:manage"), {
      grantorUserId: ids.tail, granteeUserId: ids.delegate, capability: "work:report_for_worker", scopeType: "global",
      validFrom: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 3_600_000).toISOString(), reason: "isolated global temporary proxy",
    });
    const delegated = await actor(ids.delegate, "work:report_for_worker"), f = await activate();
    await expect(rawReport(delegated, f)).resolves.toBeUndefined();
    expect((await reporting.submitReportsBatch(delegated, f.id, payload(f.data), randomUUID())).value.reworkStatus).toBe("pending_order_review");
    const pending = await activate();
    await access.revokeDelegation(await root("delegation:manage"), delegation.delegationId, "isolated revocation");
    await expect(rawReport(delegated, pending)).rejects.toMatchObject({ code: "42501" });
  });

  it("rejects an inactive or departed reporter even with a previously valid proxy context", async () => {
    const f = await activate(), who = await tail();
    const client = await database.connect();
    try {
      // Mutations stay inside a rolled-back test transaction. Preserve all
      // production identity and report guards while exercising their lookup.
      await client.query("BEGIN");
      await client.query("UPDATE identity_mappings SET employed=false WHERE user_id=$1", [ids.tail]);
      await expect(client.query("SELECT rework_work_report_actor_authorized($1,'work:report_for_worker',$2)", [who.actorId, f.data.tasks[0]!.workTaskId])).rejects.toMatchObject({ code: "42501" });
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("rejects a superseded task instead of resurrecting its temporary assignment", async () => {
    const f = await activate();
    const task = f.data.tasks.find(t => t.executionKind === "tail_inspection")!;
    await reporting.removeActiveTask(await actor(ids.tail, "work:assignment_adjust"), f.id, task.workTaskId, { expectedOrderVersion: f.data.orderVersion }, randomUUID());
    await expect(rawReport(await actor(ids.tail, "work:report_for_worker"), f)).rejects.toMatchObject({ code: "55000" });
  });

  it("resubmits an audited rejected special-process report and replays it without duplicating shares", async () => {
    const f = await activate("other_craft");
    const first = await reporting.submitReportsBatch(await tail(), f.id, payload(f.data), randomUUID());
    const specialTask = f.data.tasks.find(t => t.executionKind === "tail_inspection")!;
    const old = first.value.reports.find(r => r.workTaskId === specialTask.workTaskId)!;
    const returned = await review.rejectReport(await actor(ids.tail, "submission:audit"), old.workReportId, { expectedOrderVersion: first.value.orderVersion, rejectedPersonId: f.personId, reason: "isolated count correction" }, randomUUID());
    const who = await tail(), key = randomUUID();
    const request = { expectedOrderVersion: returned.value.orderVersion, reports: [{ workTaskId: specialTask.workTaskId, actualQuantity: 139, resubmitsWorkReportId: old.workReportId }] };
    const corrected = await reporting.submitReportsBatch(who, f.id, request, key);
    expect(corrected.value.reworkStatus).toBe("pending_order_review");
    const beforeReplay = await facts(f.id);
    expect(beforeReplay.reports.filter(r => r.resubmits_work_report_id === old.workReportId)).toHaveLength(1);
    expect((await reporting.submitReportsBatch(who, f.id, request, key)).reused).toBe(true);
    expect(await facts(f.id)).toEqual(beforeReplay);
  });

  it("materializes each temporary wage source once after IE approval and does not duplicate it on report retry", async () => {
    const f = await activate("other_craft"), who = await tail(), key = randomUUID(), request = payload(f.data);
    const reported = await reporting.submitReportsBatch(who, f.id, request, key);
    const confirmation = await review.approve(await actor(ids.tail, "submission:audit"), f.id, {
      expectedOrderVersion: reported.value.orderVersion,
      temporaryCoefficients: f.data.tasks.map(task => ({ configurationItemId: task.configurationItemId, personId: f.personId, multiplier: 1 })),
    }, randomUUID());
    const approved = await review.reviewFinalQuantity(await actor(ids.ie, "process:review"), f.id, { expectedOrderVersion: confirmation.value.orderVersion, decision: "approved" }, randomUUID());
    expect(approved.value.reworkStatus).toBe("pending_responsibility_determination");
    const wages = () => database.query("SELECT wage_item_id,work_report_id,person_id,payable_amount FROM rework_wage_items WHERE rework_order_id=$1 ORDER BY wage_item_id", [f.id]);
    const before = (await wages()).rows;
    expect(before).toHaveLength(2);
    expect(before.reduce((sum, row) => sum + Number(row.payable_amount), 0)).toBe(70);
    expect((await reporting.submitReportsBatch(who, f.id, request, key)).reused).toBe(true);
    expect((await wages()).rows).toEqual(before);
  });

  it("honors current module read-only policy even when the reporter has proxy capability", async () => {
    const grantActor = await root("access:admin");
    await access.assignRole(grantActor, { userId: ids.blocked, roleCode: "order_merchandiser", reason: "isolated mixed-role owner" });
    const delegated = await access.createDelegation(await root("delegation:manage"), {
      grantorUserId: ids.tail, granteeUserId: ids.blocked, capability: "work:report_for_worker", scopeType: "global",
      validFrom: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 3_600_000).toISOString(), reason: "isolated restricted owner proxy",
    });
    expect(delegated.delegationId).toBeTruthy();
    const who = await actor(ids.blocked, "work:report_for_worker"), f = await activate(), client = await database.connect();
    try {
      await client.query("BEGIN");
      const bindings = { li_zhonghao: ids.owner, wu_yunfeng: ids.blocked, li_junyue: ids.root };
      const operationEventId = await events.append(client, await root(), { action: "access.member_module.bind", entityType: "business_module_owner_bindings", entityId: "0915", after: bindings, reason: "isolated explicit module policy" });
      for (const [memberKey, userId] of Object.entries(bindings)) await client.query("INSERT INTO business_module_owner_bindings(member_key,user_id,operation_event_id) VALUES($1,$2,$3)", [memberKey, userId, operationEventId]);
      expect((await client.query("SELECT rework_work_report_actor_authorized($1,'work:report_for_worker',$2) allowed", [who.actorId, f.data.tasks[0]!.workTaskId])).rows[0].allowed).toBe(false);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
});
