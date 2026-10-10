import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { publishReworkNodeRefresh, reworkInitiationAccess } from "../../apps/web/src/rework-initiation-access.js";

const access = (overrides: Partial<Parameters<typeof reworkInitiationAccess>[0]> = {}) => reworkInitiationAccess({
  canHandleInitiation: true, currentUserId: "qc-a", createdByUserId: "qc-a",
  isRoot: false, status: "pending_process_configuration", ...overrides,
});

describe("QC withdrawal ownership and editable-node refresh", () => {
  it("allows only the original QC to withdraw or cancel its pending order", () => {
    expect(access()).toMatchObject({ canWithdraw: true, canCancel: true });
    expect(access({ currentUserId: "qc-b" })).toMatchObject({ canWithdraw: false, canCancel: false });
    expect(access({ createdByUserId: "root" })).toMatchObject({ canWithdraw: false, canCancel: false });
  });

  it("does not invent a foreign-order withdrawal bypass for Root or owners", () => {
    expect(access({ currentUserId: "root", isRoot: true })).toMatchObject({ canWithdraw: false, canCancel: false });
    expect(access({ currentUserId: "owner" })).toMatchObject({ canWithdraw: false, canCancel: false });
  });

  it("preserves Root draft takeover and ordinary QC draft ownership", () => {
    expect(access({ status: "draft" }).canEditDraft).toBe(true);
    expect(access({ status: "draft", currentUserId: "qc-b" }).canEditDraft).toBe(false);
    expect(access({ status: "draft", currentUserId: "root", isRoot: true }).canEditDraft).toBe(true);
  });

  it.each(["draft", "pending_ie_review", "in_progress", "completed", "cancelled"])(
    "does not display transition actions in %s", (status) => {
      expect(access({ status })).toMatchObject({ canWithdraw: false, canCancel: false });
    },
  );

  it("retains missing-session, role/capability and module-read-only restrictions", () => {
    expect(access({ currentUserId: null })).toMatchObject({ canWithdraw: false, canEditDraft: false });
    expect(access({ canHandleInitiation: false })).toMatchObject({ canWithdraw: false, canCancel: false });
    expect(access({ canHandleInitiation: false, status: "draft" }).canEditDraft).toBe(false);
  });

  it.each(["process_configuration", "initiation", undefined])(
    "selects the editable initiation node before publishing a withdrawn draft from %s", (oldNode) => {
      let selectedNode = oldNode;
      const order = { status: "draft", reworkOrderId: "same-order", reworkNo: "RW-SAME", version: 3 };
      const events: string[] = [];
      publishReworkNodeRefresh(order, "initiation", (node) => {
        selectedNode = node;
        events.push(`select:${node}`);
      }, (latest) => {
        events.push(`publish:${latest.status}`);
        expect(selectedNode).toBe("initiation");
        expect(access({ status: latest.status }).canEditDraft).toBe(true);
        expect(latest.reworkOrderId).toBe("same-order");
        expect(latest.reworkNo).toBe("RW-SAME");
      });
      expect(events).toEqual(["select:initiation", "publish:draft"]);
    },
  );

  it("does not override an explicitly selected node during an ordinary read-only reload", () => {
    const events: string[] = [];
    publishReworkNodeRefresh({ status: "draft" }, undefined,
      () => events.push("select"), () => events.push("publish"));
    expect(events).toEqual(["publish"]);
  });

  it("wires both withdrawal locations to the same ordered refresh and keeps static facts read-only", async () => {
    const page = await readFile("apps/web/src/rework-detail-page.tsx", "utf8");
    const followUps = page.split("<InitiationFollowUpActions").slice(1);
    expect(followUps).toHaveLength(2);
    for (const followUp of followUps) {
      const element = followUp.slice(0, followUp.indexOf("/>") + 2);
      expect(element).toContain("canHandleInitiation={initiationAccess.canWithdraw}");
      expect(element).toContain("onChanged={syncAfterNodeAction}");
    }
    expect(page).toContain("return initiationAccess.canEditDraft");
    expect(page).toContain("await load(undefined, true)");
    expect(page).toContain("await onChanged()");
    expect(page).toContain("撤回和取消需由原发起人操作");
    expect(page).toContain("仅展示本单已填写的业务字段。");
  });
});
