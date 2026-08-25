import { readFile } from "node:fs/promises";

import { UpdateTemporaryWorkerProfileSchema } from "@dx-rework/contracts";
import { describe, expect, it } from "vitest";

describe("Root UAT PR-03 N02 worker boundary", () => {
  it("keeps current-order selection separate from the one explicit default-roster write", async () => {
    const form = await readFile("apps/web/src/process-worker-assignment-form.tsx", "utf8");
    const endpoint = "master-data/processes/${item.processId}/default-workers";
    const saveStart = form.indexOf("const saveDefaultWorkers");
    const nextFunction = form.indexOf("const persistMergedDraft", saveStart);

    expect(form).toContain("选择本单工人");
    expect(form).toContain("保存为默认名单");
    expect(form).not.toContain("只有点击“保存为默认名单”才会更新以后订单的默认工人");
    expect(form.split(endpoint)).toHaveLength(2);
    expect(form.indexOf(endpoint)).toBeGreaterThan(saveStart);
    expect(form.indexOf(endpoint)).toBeLessThan(nextFunction);
    expect(form).toContain("onClick={() => void saveDefaultWorkers(index)}");
  });

  it("reuses the N02 dialog for an in-place temporary-worker profile update", async () => {
    const form = await readFile("apps/web/src/process-worker-assignment-form.tsx", "utf8");
    const editStart = form.indexOf("if (temporaryEditingPersonId)");
    const createStart = form.indexOf('await request("master-data/temporary-workers"', editStart);
    const editBranch = form.slice(editStart, createStart);

    expect(form).toContain("openTemporaryWorkerProfile(personId)");
    expect(form).toContain("补录或修改临时工资料");
    expect(form).toContain("disabled={busy || Boolean(temporaryEditingPersonId)}");
    expect(editBranch).toContain('method: "PUT"');
    expect(editBranch).not.toContain("reloadPeople()");
    expect(editBranch).not.toContain("onOrderChanged");
    expect(editBranch).not.toContain("location.");
  });

  it("validates nullable existing fields and keeps private values out of audit payloads", async () => {
    expect(UpdateTemporaryWorkerProfileSchema.safeParse({
      temporaryRemark: null,
      temporaryPhoneNumber: "13900139000",
      temporaryIdentityNumber: "440106199101011234",
      reason: "N02 补录临时工资料",
    }).success).toBe(true);
    expect(UpdateTemporaryWorkerProfileSchema.safeParse({
      temporaryRemark: null,
      temporaryPhoneNumber: "not-a-phone",
      temporaryIdentityNumber: null,
      reason: "N02 补录临时工资料",
    }).success).toBe(false);

    const [service, migration] = await Promise.all([
      readFile("apps/api/src/access/service.ts", "utf8"),
      readFile("apps/api/migrations/0092_temporary_worker_profile_update.sql", "utf8"),
    ]);
    const eventStart = service.indexOf("const operationEventId = await this.events.append");
    const eventEnd = service.indexOf("await client.query(", eventStart);
    const eventPayload = service.slice(eventStart, eventEnd);
    expect(eventPayload).toContain("hasTemporaryPhoneNumber");
    expect(eventPayload).toContain("hasTemporaryIdentityNumber");
    expect(eventPayload).not.toContain("input.temporaryPhoneNumber");
    expect(eventPayload).not.toContain("input.temporaryIdentityNumber");
    expect(migration).toContain("temporary worker profile update requires trusted audit context");
    expect(migration).toContain("master_data.temporary_worker_profile.update");
  });
});
