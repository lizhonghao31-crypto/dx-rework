import {acceptanceBusinessContext} from '../../apps/api/src/acceptance-clock/business-time.js';
import {publishedTechnicalFixture} from './development-technical-fixture.js';
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { expect } from "vitest";
import { DevelopmentDocumentSchema, type DevelopmentDocument } from "@dx-rework/contracts/digital-development";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import type { TodoProjectionService } from "../../apps/api/src/todos/projection-service.js";
import { PatternRoomOrderService } from "../../apps/api/src/pattern-room/order-service.js";
import { DigitalProductionIdentityService } from "../../apps/api/src/production-platform/identity-service.js";
import { DigitalDevelopmentService } from "../../apps/api/src/production-platform/development-service.js";
import { DigitalProductionTaskService } from "../../apps/api/src/production-platform/task-service.js";
import { DevelopmentExecutionService } from "../../apps/api/src/production-platform/development-execution-service.js";
import { developmentSlaEvidence } from "../../apps/api/src/production-platform/development-sla-evidence.js";
import { arrangementInput } from "./development-arrangement-fixture.js";
import { taskResult } from "./development-task-result-fixture.js";
import type {BusinessClock} from '@dx-rework/domain/business-clock';
import type {CraftStepChoice} from '@dx-rework/contracts/digital-craft';

/** Current enrollment, real migrated schema and original native execution/wage integration. */
export async function exerciseDevelopmentSlaNative(db: Pool, todos: TodoProjectionService, root: TrustedActorContext, workerId: string, clock?:BusinessClock,
  variants:readonly (readonly [DevelopmentDocument['craft'],DevelopmentDocument['washing']])[]=[["无", "免洗"], ["印花", "内洗"], ["绣花", "外洗"], ["印绣花", "内洗"]],options?:{fixedCraftSteps:CraftStepChoice[];automaticQuotation?:boolean;onRouteComplete?(sourceId:string,kind:string,taskId:string):Promise<void>}) {
  const created:Array<{sourceId:string;orderId:string}>=[];
  const native = new PatternRoomOrderService(db, todos, { ordersEnabled: true });
  const forms = new DigitalDevelopmentService(db, true, native), execution = new DevelopmentExecutionService(db, true, native);
  const identity = new DigitalProductionIdentityService(db, true);
  const clerkId = (await db.query("SELECT user_id FROM user_role_assignments WHERE role_code='development_clerk' AND revoked_at IS NULL LIMIT 1")).rows[0].user_id;
  const clerk = { ...root, actorId: clerkId, actorRoles: ["development_clerk"], authorizationCapability: "digital_production:view", authorizationCapabilities: ["digital_production:view", "todo:view"] };
  const worker = { ...root, actorId: workerId, actorRoles: ["pattern_room_worker"], authorizationCapability: "pattern_room:orders:complete", authorizationCapabilities: ["pattern_room:orders:complete", "pattern_room:orders:view", "digital_production:view"] };
  const price = (await db.query("SELECT price_id,version FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0];
  for (const [craft, washing] of variants) {
    const { sourceId } = await identity.createSource(root, { developmentType: "头版", designStyleNo: `TEST-SLA03-${randomUUID()}`, temporaryStyleNo: null, customerCode: options?.automaticQuotation?"PD":null }, randomUUID());
    const fileId = randomUUID(), materialId = randomUUID();
    await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)", [fileId, `test-sla03/${fileId}`, "a".repeat(64), root.actorId]);
    const document = DevelopmentDocumentSchema.parse({ ...(options?.automaticQuotation?{quotationMode:'automatic_v1'}:{}),documentFormatVersion: 2, sizeQuantities: [1], template: "上衣", quantity: 1, sampleSize: "M", orderDate: null, returnDate: null,
      unit: "cm", sizes: ["M"], measurements: [{ name: "胸围", values: ["50"] }], interlining: "", placketInterlining: "", sewingThread: "", buttonholeThread: "", stitchDensity: "", washingIroning: "", packaging: "", formalSizes: "", casualSizes: "",
      mainLabel: false, mainLabelMethod: "", sizeLabel: false, careLabel: false, instructions: "", craft, washing,...(options?{craftSteps:options.fixedCraftSteps}:{}),
      materials: [{ ...(options?.automaticQuotation?{pricingUnit:'米',unitPrice:'20'}:{}),materialId, category: "主布", label: "主布", name: "棉", supplier: "TEST", width: "", weight: "", composition: "", consumption: "", color: "黑", specification: "TEST40支", quantity: "1", requiredThisRound: true, available: true, expectedDate: null }], files: [{ attachmentId: fileId, kind: "款图" }] });
    const draft = await forms.save(root, sourceId, { expectedVersion: 0, document }, randomUUID());
    const published = await forms.publish(root, sourceId, draft.version, randomUUID(), { categoryId: price.price_id, priceVersion: price.version });
    const state = () => execution.read(root, sourceId);
    const task = async (kind: string) => (await state()).tasks.filter(row => row.routeVersion === 1 && row.taskKind === kind).at(-1)!;
    expect(await task("development_materials")).toMatchObject({ slaHours: 4, enteredAt: published.publishedAt });
    const fixed = (await state()).fixedCutting!;
    if (!fixed.valid || fixed.assigneeId !== workerId) await execution.configureFixedCutting(root, sourceId, { expectedVersion: fixed.version, assigneeId: workerId, reason: "TEST开发固定裁板" }, randomUUID());
    const checks = [{ materialId, physical: true, quantity: true, color: true, specification: true }];
    const verification = (await execution.read(clerk, sourceId)).materialVerification!;
    await execution.saveMaterials(clerk, sourceId, { taskId: published.taskId!, expectedDocumentVersion: verification.documentVersion, expectedVersion: verification.version, note: "TEST核实", result: "通过", entries: checks.map(row => ({ ...row, usage: "use", note: "", confirmedWith: "" })) }, randomUUID());
    await execution.check(clerk, sourceId, { taskId: published.taskId!, expectedVerificationVersion: verification.version + 1, result: "通过", note: "TEST实物齐备", items: checks }, randomUUID());
    await execution.arrange(clerk, sourceId, await arrangementInput(db, execution, clerk, sourceId, workerId), randomUUID());
    for (const kind of ["development_pattern", "development_cutting"]) {
      const current = await task(kind);
      expect(current).toMatchObject({ state: "ready", slaHours: kind === "development_pattern" ? 48 : 4, assigneeId: workerId });
      const artifact=kind==='development_pattern'?await publishedTechnicalFixture(db,root,sourceId,published.document!,published.version,workerId):null;
      await execution.complete(root, sourceId, { taskId: current.taskId, note: "TEST完成", attachmentIds:[],...(artifact?{artifactRef:{id:artifact.artifactSetId,version:artifact.version,scopeRef:'整款'}}:{}) }, randomUUID());
    }
    const route = async (kind: string) => {
      const current = await task(kind), actor = kind === "development_sewing" ? worker : root;
      const result=await execution.route(actor, sourceId, { taskId: current.taskId, result: "通过", note: "TEST实做", craftExecution: kind === "development_craft_dispatch" ? "内部" : null,
        nextAssigneeId: null, sentDate: null, trackingNo: null,
        ...(kind === "development_pre_wash_check" || kind === "development_tail_check" ? { measurements: [{ name: "胸围", values: [kind === "development_pre_wash_check" ? "51" : "50"] }] } : {}),
        ...(["development_sewing", "development_tail_check","development_printing","development_embroidery","development_print_embroidery"].includes(kind) ? { attachmentIds: [await taskResult(db, execution, actor, sourceId, current.taskId, kind === "development_sewing" ? "车板成果" : kind === "development_tail_check"?"尾查照片":"工艺回样照片")] } : {}) }, randomUUID());
      await options?.onRouteComplete?.(sourceId,kind,current.taskId);return result;
    };
    if (craft !== "无") {
      const position=await task('development_positioning'),technical=execution.technicalEvidenceService(),group=(await technical.read(root,sourceId)).artifacts.find(a=>a.status==='published')!;
      if(position.state!=='ready'){const candidates=(await db.query("SELECT a.user_id FROM user_role_assignments a JOIN app_users u ON u.id=a.user_id WHERE a.role_code='sample_designer' AND a.revoked_at IS NULL AND u.enabled ORDER BY a.user_id")).rows;const context=acceptanceBusinessContext();let designer:string|undefined;for(const candidate of candidates)if(!context||await context.acceptsActor(candidate.user_id)){designer=candidate.user_id;break;}if(!designer)throw Error("TEST fixture has no eligible original designer in this scene");await new DigitalProductionTaskService(db).reassign(root,position.taskId,designer,randomUUID());}
      await technical.completePosition(root,sourceId,{taskId:position.taskId,artifactSetId:group.artifactSetId,artifactVersion:group.version,attachmentIds:[await taskResult(db,execution,root,sourceId,position.taskId,'定位图')],note:'TEST本轮定位依据'},randomUUID());
      const kinds=options?options.fixedCraftSteps.map(step=>step.craftKind==='embroidery'?'development_embroidery':'development_printing'):[craft === "印花" ? "development_printing" : craft === "绣花" ? "development_embroidery" : "development_print_embroidery"];
      for(const [index,kind] of kinds.entries()){
        if(options)expect(await task('development_craft_dispatch')).toMatchObject({slaHours:0.5});
        await route("development_craft_dispatch");
        const special=options?.fixedCraftSteps[index]?.specialCraft;
        expect(await task(kind)).toMatchObject({slaHours:special?special.definition.development.minutes!/60:options&&options.fixedCraftSteps.length===2?null:craft === "印绣花" ? 168 : 96});
        await route(kind);if(options)expect(await task('development_craft_confirmation')).toMatchObject({slaHours:0.5});await route("development_craft_confirmation");
      }
      const sewing=await task("development_sewing");
      expect(sewing.state).toBe("pending");
      expect((await db.query("SELECT satisfied,occurred_at FROM digital_production_task_conditions WHERE task_id=$1 AND condition_key='handover_received'",[sewing.taskId])).rows[0]).toEqual({satisfied:false,occurred_at:null});
      // No completed work or wages can be manufactured by a system route.
      await expect(route("development_sewing")).rejects.toMatchObject({statusCode:409});
      const receiptKey=randomUUID(),tasks=new DigitalProductionTaskService(db);
      await tasks.handover(worker,sewing.taskId,{note:"TEST师傅实际收到工艺返回裁片"},receiptKey);
      await tasks.handover(worker,sewing.taskId,{note:"TEST师傅实际收到工艺返回裁片"},receiptKey);
      expect((await db.query("SELECT satisfied FROM digital_production_task_conditions WHERE task_id=$1 AND condition_key='handover_received'",[sewing.taskId])).rows[0]).toEqual({satisfied:true});
      expect(await task("development_sewing")).toMatchObject({enteredAt:sewing.enteredAt,dueAt:sewing.dueAt});

    }
    expect(await task("development_sewing")).toMatchObject({ state: "ready", slaHours: 24 });
    await route("development_sewing");
    const linked = (await state()).patternOrder!;
    created.push({sourceId,orderId:linked.orderId});
    expect((await native.get(root, linked.orderId)).status).toBe("pending_confirmation");
    if (washing !== "免洗") {
      expect(await task("development_pre_wash_check")).toMatchObject({ state: "ready", slaHours: 0.5 });
      await route("development_pre_wash_check");
      await execution.sendWashing(root, sourceId, (await task("development_washing_dispatch")).taskId, "TEST实际送洗", randomUUID());
      expect(await task("development_washing")).toMatchObject({ state: "ready", slaHours:washing==='外洗'?72:24 });
      await route("development_washing");
    } else expect(await task("development_pre_wash_check")).toBeUndefined();
    expect(await task("development_tail_check")).toMatchObject({ state: "ready", slaHours: 0.5 });
    await route("development_tail_check");
    // Development quality completion does not bypass original designer/native financial confirmation.
    expect((await native.get(root, linked.orderId)).status).toBe("pending_confirmation");
    await route("development_confirmation");
    expect((await native.get(root, linked.orderId)).status).toBe("completed");
    expect((await db.query("SELECT worker_user_id,wage_eligible_at FROM pattern_room_segments s JOIN pattern_room_rounds r USING(round_id) WHERE r.order_id=$1", [linked.orderId])).rows).toEqual([expect.objectContaining({ worker_user_id: workerId, wage_eligible_at: expect.any(Date) })]);
    const facts = await developmentSlaEvidence(db, sourceId, clock?await clock.read({kind:'source',id:sourceId}):{ now: new Date().toISOString(), scenarioId: null, revision: 0 });
    expect(facts!.facts.development_tail_check?.completedAt).toBeTruthy();
    expect(facts!.facts.development_materials?.standardMinutes).toBe(240);
    const recorded = (await db.query("SELECT payload->'inspection' AS inspection FROM digital_development_route_facts WHERE source_id=$1 AND kind IN ('洗前检查','尾查通过') ORDER BY sequence", [sourceId])).rows;
    if (washing !== "免洗") expect(recorded).toMatchObject([{ inspection: { phase: "洗前", measurements: [{ values: ["51"] }] } }, { inspection: { phase: "洗后", measurements: [{ values: ["50"] }] } }]);
    else expect(recorded).toMatchObject([{inspection:{phase:"尾查",measurements:[{values:["50"]}]}}]);
  }
  return created;
}
