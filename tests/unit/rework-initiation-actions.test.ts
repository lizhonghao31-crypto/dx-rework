import { Children, createElement, isValidElement, type ReactNode } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InitiationFollowUpActions } from "../../apps/web/src/rework-initiation-actions.js";
import { publishReworkNodeRefresh, reworkInitiationAccess } from "../../apps/web/src/rework-initiation-access.js";
import { promptInApp } from "../../apps/web/src/system-dialog.js";

const hooks = vi.hoisted(() => ({
  direct: false, calls: 0, setMessage: vi.fn(), setBusy: vi.fn(),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return { ...actual, useState: (...args: unknown[]) => {
    if (!hooks.direct) return (actual.useState as (...args: unknown[]) => unknown)(...args);
    const initial = args[0];
    return [typeof initial === "function" ? initial() : initial,
      hooks.calls++ === 0 ? hooks.setMessage : hooks.setBusy];
  } };
});
vi.mock("../../apps/web/src/system-dialog.js", () => ({ promptInApp: vi.fn() }));

const detail = { reworkOrderId: "same-order", status: "pending_process_configuration", version: 2 };
const props = (currentUserId: string, isRoot = false) => ({
  detail, statusLabel: "待分配工序 & 工人",
  canHandleInitiation: reworkInitiationAccess({
    canHandleInitiation: true, currentUserId, createdByUserId: "qc-a", isRoot, status: detail.status,
  }).canWithdraw,
  ownershipNotice: !isRoot && currentUserId !== "qc-a" ? "本单由其他质检发起；撤回和取消需由原发起人操作。" : undefined,
  onChanged: vi.fn(),
});
function withdrawalButton(node: ReactNode): { disabled?: boolean; onClick?: () => void } | undefined {
  if (!isValidElement<{ children?: ReactNode; disabled?: boolean; onClick?: () => void }>(node)) return undefined;
  if (node.props.children === "撤回修改") return node.props;
  for (const child of Children.toArray(node.props.children)) {
    const found = withdrawalButton(child);
    if (found) return found;
  }
  return undefined;
}
afterEach(() => { hooks.direct = false; hooks.calls = 0; vi.unstubAllGlobals(); });

describe("actual N01 maintenance action component", () => {
  it.each([["Root foreign", "root", true], ["Root own", "qc-a", true], ["QC own", "qc-a", false]] as const)(
    "renders enabled withdrawal and cancellation for %s", (_case, id, isRoot) => {
      const html = renderToStaticMarkup(createElement(InitiationFollowUpActions, props(id, isRoot)));
      expect(html).toContain("撤回修改");
      expect(html).toContain("取消返工单");
      expect(html).not.toContain("disabled");
      expect(html).not.toContain("需由原发起人");
    },
  );
  it("renders disabled actions with an explicit ownership explanation for foreign QC", () => {
    const html = renderToStaticMarkup(createElement(InitiationFollowUpActions, props("qc-b")));
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain("需由原发起人操作");
  });
  it("does not render action buttons for a role without initiation permission", () => {
    const html = renderToStaticMarkup(createElement(InitiationFollowUpActions,
      { ...props("qc-a"), canHandleInitiation: false }));
    expect(html).not.toContain("<button");
  });
  it("executes the real withdrawal handler and selects N01 before publishing the returned draft", async () => {
    hooks.direct = true;
    vi.mocked(promptInApp).mockResolvedValue(" 修订资料 ");
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    let selectedNode = "process_configuration";
    const events: string[] = [];
    const onChanged = vi.fn(async () => {
      const latest = { status: "draft", reworkOrderId: detail.reworkOrderId, version: 3 };
      publishReworkNodeRefresh(latest, "initiation", (node) => {
        selectedNode = node; events.push("select");
      }, (draft) => {
        events.push("publish");
        expect(selectedNode).toBe("initiation");
        expect(reworkInitiationAccess({ canHandleInitiation: true, currentUserId: "root",
          createdByUserId: "qc-a", isRoot: true, status: draft.status }).canEditDraft).toBe(true);
      });
    });
    const button = withdrawalButton(InitiationFollowUpActions({ ...props("root", true), onChanged }));
    expect(button?.disabled).toBe(false);
    button?.onClick?.();
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/rework-orders/same-order/withdraw",
      expect.objectContaining({ method: "POST", credentials: "include",
        body: JSON.stringify({ expectedVersion: 2, reason: "修订资料" }) }));
    expect(events).toEqual(["select", "publish"]);
  });
  it("retains a service refusal without publishing a false draft or changing the selected node", async () => {
    hooks.direct = true;
    vi.mocked(promptInApp).mockResolvedValue("撤回");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false,
      json: async () => ({ error: { message: "尾部已开始配置" } }) })));
    const p = props("root", true);
    withdrawalButton(InitiationFollowUpActions(p))?.onClick?.();
    await vi.waitFor(() => expect(hooks.setMessage).toHaveBeenCalledWith("尾部已开始配置"));
    expect(p.onChanged).not.toHaveBeenCalled();
  });
  it("does not dispatch a disabled foreign-QC action even if its callback is invoked directly", async () => {
    hooks.direct = true;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const button = withdrawalButton(InitiationFollowUpActions(props("qc-b")));
    expect(button?.disabled).toBe(true);
    button?.onClick?.();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
