// @vitest-environment jsdom
// Real React panels and controls; every network boundary uses synthetic fixtures.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ResponsibilityDeterminationResponseSchema } from "@dx-rework/contracts";
import { ExternalResponsibilityBatchResponseSchema } from "@dx-rework/contracts/external-responsibility";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResponsibilityDeterminationPanel } from "../../apps/web/src/responsibility-determination-panel.js";
import { ExternalResponsibilityPanel } from "../../apps/web/src/external-responsibility-panel.js";

const ports = vi.hoisted(() => ({ verifySession: vi.fn(), currentModuleCanWrite: vi.fn() }));
vi.mock("../../apps/web/src/auth.js", () => ({ verifySession: ports.verifySession }));
vi.mock("../../apps/web/src/member-module-policy.js", () => ({ currentModuleCanWrite: ports.currentModuleCanWrite }));

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const orderA = id(1), orderB = id(2), actorId = id(3), supplierId = id(4);
const candidate = { supplierId, supplierType: "factory", supplierName: "TEST 正确候选工厂" };
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function determination(orderId = orderA, name = "TEST 当前工序") {
  return ResponsibilityDeterminationResponseSchema.parse({
    reworkOrderId: orderId, reworkStatus: "pending_responsibility_determination", orderVersion: 8,
    tailInspectionRequired: false, handlerUserId: actorId,
    canDetermine: true, canTakeover: false, canConfirmHighMultiplier: false, canOwnerSign: false,
    sourceProcesses: [{ configurationItemId: id(5), processName: name, pricingUnit: "piece",
      executionKind: "worker", includedInResponsibility: true, baseAmount: "10.00" }],
    determination: { determinationId: id(6), version: 1, stage: "draft", reason: name,
      calculationTotal: "12.00", highMultiplierConfirmed: false,
      processes: [{ configurationItemId: id(5), processName: name, pricingUnit: "piece",
        multiplier: "1.000", highMultiplierReason: null, baseAmount: "10.00", responsibilityAmount: "12.00",
        allocations: [{ responsibilityType: "processing_factory", shareBps: 10000, roundedAmount: "12.00",
          multiplier: "1.200", supplier: { supplierId, version: 1, code: "TEST-F", name: candidate.supplierName, type: "factory" } }] }] },
  });
}
function ledger(orderId = orderA, name = "TEST 未分配") {
  const unassigned = { externalItemId: id(20), configurationItemId: id(21), responsibilityType: "processing_factory",
    processSnapshot: { processName: name }, multiplierSnapshot: "1.200", shareBpsSnapshot: 10000,
    proposedAmount: "12.00", amountLineSnapshot: {} };
  const assigned = { ...unassigned, externalItemId: id(22), configurationItemId: id(23),
    processSnapshot: { processName: "TEST 已分配工序" } };
  return ExternalResponsibilityBatchResponseSchema.parse({
    batchId: id(24), reworkOrderId: orderId, finalizedDeterminationId: id(25), finalizedDeterminationVersion: 1,
    batchVersion: 1, status: "active", sourceSnapshot: { testSnapshot: "unchanged" },
    items: [unassigned, assigned], canAllocateSuppliers: true,
    cases: [{ caseId: id(26), batchId: id(24), reworkOrderId: orderId, responsibilityType: "processing_factory",
      supplier: { supplierId: id(27), version: 1, code: "TEST-EXISTING", name: "TEST 已有台账工厂", type: "factory" },
      businessHandlerUserId: actorId, payablesHandlerRole: "factory_payables",
      proposedDeductionAmount: "12.00", actualDeductedAmount: "0.00", remainingAmount: "12.00", caseVersion: 1,
      status: "pending_payables_confirmation", submittedAt: null, payablesConfirmedAt: null,
      canSign: false, canPayablesConfirm: false, canFollowUp: false, canRecordDeduction: true,
      canClose: false, canRequestSpecialApproval: false, canDecideSpecialApproval: false,
      canRequestRevision: false, canApproveRevision: false, items: [assigned], deductions: [],
      followUps: [], closure: null, specialApproval: null, revisionRequests: [] }],
  })!;
}

type ReadRequest = { url: string; init: RequestInit | undefined };
type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
let container: HTMLDivElement;
let root: Root | null;
let reads: ReadRequest[];
function mockFetch(handler: (url: string, init: RequestInit | undefined) => Promise<Response>): void {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    reads.push({ url, init });
    if (init?.method && init.method !== "GET") throw new Error(`Unexpected synthetic write: ${url}`);
    return handler(url, init);
  }));
}
const supplierReads = () => reads.filter(({ url }) => url.endsWith("/supplier-options"));
const mainReads = () => reads.filter(({ url }) => !url.endsWith("/supplier-options"));
async function renderN07(orderId: string): Promise<void> {
  await act(async () => { root!.render(createElement(ResponsibilityDeterminationPanel, { reworkOrderId: orderId })); });
}
async function renderN09(orderId = orderA, readOnly = false): Promise<void> {
  await act(async () => { root!.render(createElement(ExternalResponsibilityPanel, { reworkOrderId: orderId, readOnly })); });
}
async function unmount(): Promise<void> {
  await act(async () => { root?.unmount(); });
  root = null;
}
function button(text: string, scope: ParentNode = container): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === text);
  expect(found, `button: ${text}`).toBeDefined();
  return found!;
}
function field(text: string, scope: ParentNode = container): Field {
  const label = [...scope.querySelectorAll("label")].find(node => node.firstElementChild?.textContent === text);
  const found = label?.querySelector<Field>("input,select,textarea");
  expect(found, `field: ${text}`).toBeTruthy();
  return found!;
}
async function click(element: HTMLElement): Promise<void> {
  await act(async () => { element.click(); });
}
async function fill(element: Field, value: string): Promise<void> {
  await act(async () => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
const reasonLabel = "共同责任记录 / 修改说明（可选）";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  ports.verifySession.mockResolvedValue({ status: "authorized", user: { id: actorId } });
  ports.currentModuleCanWrite.mockResolvedValue(true);
  reads = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await unmount();
  container.remove();
  vi.unstubAllGlobals();
});

describe("N07 real responsibility panel request lifecycle", () => {
  it("keeps the latest A and its draft after A to B to A delayed main responses", async () => {
    const firstA = deferred<Response>(), oldB = deferred<Response>();
    let aCalls = 0;
    mockFetch(async url => {
      if (url.endsWith("/supplier-options")) return json({ items: [candidate] });
      if (url.includes(orderB)) return oldB.promise;
      return ++aCalls === 1 ? firstA.promise : json(determination(orderA, "TEST 最新A"));
    });
    await renderN07(orderA);
    const firstSignal = mainReads()[0]!.init?.signal;
    await renderN07(orderB);
    await renderN07(orderA);
    await fill(field(reasonLabel), "TEST 本次未保存说明");
    await act(async () => { oldB.resolve(json(determination(orderB, "TEST 旧B"))); firstA.resolve(json(determination(orderA, "TEST 旧A"))); });
    expect(firstSignal?.aborted).toBe(true);
    expect(container.textContent).toContain("TEST 最新A");
    expect(container.textContent).not.toContain("TEST 旧A");
    expect(container.textContent).not.toContain("TEST 旧B");
    expect(field(reasonLabel).value).toBe("TEST 本次未保存说明");
    expect(supplierReads()).toHaveLength(1);
  });

  it("ignores a late failure from the first A after returning to A", async () => {
    const old = deferred<Response>();
    let aCalls = 0;
    mockFetch(async url => url.endsWith("/supplier-options") ? json({ items: [candidate] })
      : url.includes(orderA) && ++aCalls === 1 ? old.promise : json(determination(url.includes(orderB) ? orderB : orderA, "TEST 新页面")));
    await renderN07(orderA); await renderN07(orderB); await renderN07(orderA);
    await act(async () => { old.reject(new Error("TEST 旧请求错误")); });
    expect(container.textContent).toContain("TEST 新页面");
    expect(container.textContent).not.toContain("TEST 旧请求错误");
  });

  it("ignores delayed identity after details resolve across A to B to A", async () => {
    const firstIdentity = deferred<{ status: "authorized"; user: { id: string } }>();
    ports.verifySession.mockImplementationOnce(() => firstIdentity.promise);
    let aCalls = 0;
    mockFetch(async url => {
      if (url.endsWith("/supplier-options")) return json({ items: [candidate] });
      const isB = url.includes(orderB);
      const name = isB ? "TEST 身份中间B" : ++aCalls === 1 ? "TEST 身份旧A" : "TEST 身份最新A";
      const detail = determination(isB ? orderB : orderA, name);
      detail.handlerUserId = null;
      return json(detail);
    });
    await renderN07(orderA);
    expect(mainReads()).toHaveLength(1);
    expect(ports.currentModuleCanWrite).not.toHaveBeenCalled();
    await renderN07(orderB); await renderN07(orderA);
    await fill(field(reasonLabel), "TEST 当前身份草稿");
    await fill(field("扣款倍率（最低 1.2）"), "1.500");
    expect(supplierReads()).toHaveLength(2);
    await act(async () => { firstIdentity.resolve({ status: "authorized", user: { id: id(99) } }); });
    expect(mainReads()[0]!.init?.signal?.aborted).toBe(true);
    expect(ports.verifySession).toHaveBeenCalledTimes(3);
    expect(ports.currentModuleCanWrite).toHaveBeenCalledTimes(2);
    expect(supplierReads()).toHaveLength(2);
    expect(container.textContent).toContain("TEST 身份最新A");
    expect(container.textContent).not.toContain("TEST 身份旧A");
    expect(container.textContent).not.toContain("TEST 身份中间B");
    expect(field(reasonLabel).value).toBe("TEST 当前身份草稿");
    expect(field("扣款倍率（最低 1.2）").value).toBe("1.500");

    // Capture only the synthetic draft payload to observe the current-user fallback.
    // The mock rejects the write; no service or business data is touched.
    const readFetch = globalThis.fetch;
    const drafts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "POST") return readFetch(input, init);
      expect(String(input)).toContain(`rework-orders/${orderA}/responsibility-determinations/drafts`);
      drafts.push(JSON.parse(String(init.body)));
      return json({ error: { message: "TEST synthetic draft captured" } }, 409);
    }));
    await click(button("提交责任判定"));
    await click(button("确认", document.body));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ handlerUserId: actorId, reason: "TEST 当前身份草稿" });
  });

  it("rechecks the generation after delayed module permission returns", async () => {
    const permission = deferred<boolean>();
    ports.currentModuleCanWrite.mockImplementationOnce(() => permission.promise);
    mockFetch(async url => url.endsWith("/supplier-options") ? json({ items: [candidate] })
      : json(determination(url.includes(orderB) ? orderB : orderA, "TEST 当前权限版本")));
    await renderN07(orderA); await renderN07(orderB); await renderN07(orderA);
    await act(async () => { permission.resolve(false); });
    expect(button("提交责任判定").disabled).toBe(false);
    expect(field(reasonLabel).value).toBe("TEST 当前权限版本");
    expect(supplierReads()).toHaveLength(2);
  });

  it("aborts an unmounted main read and never starts its permission or supplier follow-up", async () => {
    const old = deferred<Response>();
    mockFetch(async () => old.promise);
    await renderN07(orderA);
    const signal = reads[0]!.init?.signal;
    await unmount();
    await act(async () => { old.resolve(json(determination())); });
    expect(signal?.aborted).toBe(true);
    expect(ports.currentModuleCanWrite).not.toHaveBeenCalled();
    expect(supplierReads()).toHaveLength(0);
    expect(container.childElementCount).toBe(0);
  });

  it("does not start supplier reads after unmounting during permission resolution", async () => {
    const permission = deferred<boolean>();
    ports.currentModuleCanWrite.mockReturnValue(permission.promise);
    mockFetch(async () => json(determination()));
    await renderN07(orderA); await unmount();
    await act(async () => { permission.resolve(true); });
    expect(supplierReads()).toHaveLength(0);
  });

  it("retains ordinary and batch drafts when retrying a failed supplier lookup", async () => {
    const retried = deferred<Response>();
    let candidateCalls = 0;
    mockFetch(async url => !url.endsWith("/supplier-options") ? json(determination())
      : ++candidateCalls === 1 ? json({ error: { message: "unavailable" } }, 500) : retried.promise);
    await renderN07(orderA);
    await fill(field("承担比例（%）"), "65");
    await fill(field("扣款倍率（最低 1.2）"), "1.500");
    await fill(field(reasonLabel), "TEST 保留普通草稿");
    await click(container.querySelector<HTMLInputElement>('input[aria-label="选择工序 TEST 当前工序"]')!);
    await click(button("批量判责"));
    const dialog = container.querySelector('[role="dialog"]')!;
    await fill(field("承担比例（%）", dialog), "77");
    await fill(field("扣款倍率（最低 1.2）", dialog), "1.700");
    await click(button("重试加载供应商"));
    expect([...container.querySelectorAll<HTMLInputElement>('input[role="combobox"]')].every(input => input.disabled)).toBe(true);
    await act(async () => { retried.resolve(json({ items: [candidate] })); });
    expect(field("承担比例（%）").value).toBe("65");
    expect(field("扣款倍率（最低 1.2）").value).toBe("1.500");
    expect(field(reasonLabel).value).toBe("TEST 保留普通草稿");
    expect(field("承担比例（%）", dialog).value).toBe("77");
    expect(field("扣款倍率（最低 1.2）", dialog).value).toBe("1.700");
    expect(mainReads()).toHaveLength(1);
    expect(supplierReads()).toHaveLength(2);
  });

  it("aborts pending supplier reads on unmount and ignores their eventual response", async () => {
    const pending = deferred<Response>();
    mockFetch(async url => url.endsWith("/supplier-options") ? pending.promise : json(determination()));
    await renderN07(orderA);
    const signal = supplierReads()[0]!.init?.signal;
    await unmount();
    await act(async () => { pending.resolve(json({ items: [candidate] })); });
    expect(signal?.aborted).toBe(true);
    expect(container.childElementCount).toBe(0);
    expect(reads).toHaveLength(2);
  });

  it("still reports a current main-load failure", async () => {
    mockFetch(async () => { throw new Error("TEST 当前加载失败"); });
    await renderN07(orderA);
    expect(container.textContent).toContain("TEST 当前加载失败");
  });
});

describe("N09 real external responsibility candidate states", () => {
  it("recovers a 503 ledger through refresh and starts candidate loading", async () => {
    const candidates = deferred<Response>();
    let ledgerCalls = 0;
    mockFetch(async url => {
      if (url.endsWith("/supplier-options")) return candidates.promise;
      return ++ledgerCalls === 1 ? json({ error: { message: "TEST 台账暂不可用" } }, 503) : json(ledger());
    });
    await renderN09();
    expect(container.textContent).toContain("TEST 台账暂不可用");
    expect(mainReads()).toHaveLength(1);
    expect(supplierReads()).toHaveLength(0);
    await click(button("刷新"));
    expect(mainReads()).toHaveLength(2);
    expect(supplierReads()).toHaveLength(1);
    expect(container.textContent).toContain("TEST 已有台账工厂");
    expect(container.textContent).toContain("正在加载责任供应商");
    expect(container.textContent).not.toContain("TEST 台账暂不可用");
    expect(container.querySelector(".external-temporary-supplier")).toBeNull();
    const selection = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    expect(selection.disabled).toBe(true);
    expect(selection.placeholder).toBe("正在加载供应商…");
    expect(button("确认供应商").disabled).toBe(true);
    await act(async () => { candidates.resolve(json([candidate])); });
    expect(selection.disabled).toBe(false);
    expect(selection.placeholder).toBe("输入供应商名称搜索");
    expect(container.querySelector(".external-temporary-supplier")).toBeNull();
    await click(container.querySelector<HTMLButtonElement>(".search-select__toggle")!);
    await click(container.querySelector<HTMLButtonElement>('[role="option"]')!);
    expect(selection.value).toBe(candidate.supplierName);
    expect(button("确认供应商").dataset.ready).toBe("true");
    expect(supplierReads()).toHaveLength(1);
  });

  it("shows loading until a successful empty array permits the original controlled add entry", async () => {
    const pending = deferred<Response>();
    mockFetch(async url => url.endsWith("/supplier-options") ? pending.promise : json(ledger()));
    await renderN09();
    expect(container.textContent).toContain("正在加载责任供应商");
    expect(container.querySelector(".external-temporary-supplier")).toBeNull();
    expect(button("确认供应商").disabled).toBe(true);
    await act(async () => { pending.resolve(json([])); });
    expect(container.querySelector<HTMLInputElement>('input[role="combobox"]')!.placeholder).toBe("没有匹配类型的供应商");
    expect(button("新增并选择")).toBeTruthy();
    expect(container.textContent).toContain("TEST 已有台账工厂");
  });

  it.each([401, 403])("keeps supplier HTTP %s distinct from a successful empty catalog", async status => {
    mockFetch(async url => url.endsWith("/supplier-options") ? json({ error: { message: "denied" } }, status) : json(ledger()));
    await renderN09();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("当前无权读取责任供应商");
    expect(container.querySelector<HTMLInputElement>('input[role="combobox"]')!.placeholder).toBe("无权读取供应商");
    expect(container.querySelector(".external-temporary-supplier")).toBeNull();
    expect(button("确认供应商").disabled).toBe(true);
    expect(container.textContent).toContain("TEST 已有台账工厂");
  });

  it.each(["http", "network", "object", "invalid-json"] as const)("shows a retryable %s failure without exposing an empty-catalog add action", async failure => {
    mockFetch(async url => {
      if (!url.endsWith("/supplier-options")) return json(ledger());
      if (failure === "network") throw new Error("TEST disconnected");
      if (failure === "http") return json({ error: { message: "unavailable" } }, 500);
      return failure === "object" ? json({ items: [candidate] }) : new Response("not json", { status: 200 });
    });
    await renderN09();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(button("重试加载供应商").disabled).toBe(false);
    expect(container.querySelector<HTMLInputElement>('input[role="combobox"]')!.placeholder).toBe("供应商加载失败");
    expect(container.querySelector(".external-temporary-supplier")).toBeNull();
    expect(button("确认供应商").disabled).toBe(true);
    expect(container.textContent).toContain("TEST 已有台账工厂");
  });

  it("preserves selected suppliers, reasons and deduction drafts through failure and candidate-only retry", async () => {
    let calls = 0;
    const retried = deferred<Response>();
    mockFetch(async url => !url.endsWith("/supplier-options") ? json(ledger())
      : ++calls === 1 ? json([candidate]) : calls === 2 ? json({}, 503) : retried.promise);
    await renderN09();
    await click(container.querySelector<HTMLButtonElement>(".search-select__toggle")!);
    await click(container.querySelector<HTMLButtonElement>('[role="option"]')!);
    await fill(field("加工厂改选原因"), "TEST 不丢改选说明");
    await fill(field("本次扣款金额"), "2.50");
    await renderN09(orderA, true);
    await renderN09(orderA, false);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    const beforeRetryMainCount = mainReads().length;
    await click(button("重试加载供应商"));
    expect(field("加工厂改选原因").value).toBe("TEST 不丢改选说明");
    expect(field("本次扣款金额").value).toBe("2.50");
    await act(async () => { retried.resolve(json([candidate])); });
    expect(container.querySelector<HTMLInputElement>('input[role="combobox"]')!.value).toBe(candidate.supplierName);
    expect(field("加工厂改选原因").value).toBe("TEST 不丢改选说明");
    expect(field("本次扣款金额").value).toBe("2.50");
    expect(mainReads()).toHaveLength(beforeRetryMainCount);
    expect(supplierReads()).toHaveLength(3);
    expect(container.textContent).toContain("TEST 已有台账工厂");
  });

  it("ignores old A candidates after A to B to A", async () => {
    const old = deferred<Response>();
    let aCandidates = 0;
    mockFetch(async url => {
      if (!url.endsWith("/supplier-options")) return json(ledger(url.includes(orderB) ? orderB : orderA));
      if (url.includes(orderA) && ++aCandidates === 1) return old.promise;
      return json([candidate]);
    });
    await renderN09(orderA); await renderN09(orderB); await renderN09(orderA);
    await act(async () => { old.resolve(json([])); });
    expect(container.querySelector<HTMLInputElement>('input[role="combobox"]')!.placeholder).toBe("输入供应商名称搜索");
    expect(container.querySelector(".external-temporary-supplier")).toBeNull();
    expect(supplierReads()[0]!.init?.signal?.aborted).toBe(true);
  });

  it("ignores an old N09 main error after switching to a newer order", async () => {
    const old = deferred<Response>();
    mockFetch(async url => url.endsWith("/supplier-options") ? json([candidate])
      : url.includes(orderA) ? old.promise : json(ledger(orderB, "TEST 最新B台账")));
    await renderN09(orderA); await renderN09(orderB);
    await act(async () => { old.reject(new Error("TEST 旧台账错误")); });
    expect(container.textContent).toContain("TEST 最新B台账");
    expect(container.textContent).not.toContain("TEST 旧台账错误");
  });

  it.each(["main", "suppliers"] as const)("aborts an unmounted N09 %s request without starting later work", async pendingKind => {
    const pending = deferred<Response>();
    mockFetch(async url => pendingKind === "main" || url.endsWith("/supplier-options") ? pending.promise : json(ledger()));
    await renderN09();
    const last = reads.at(-1)!;
    const count = reads.length;
    await unmount();
    await act(async () => { pending.resolve(json(pendingKind === "main" ? ledger() : [candidate])); });
    expect(last.init?.signal?.aborted).toBe(true);
    expect(reads).toHaveLength(count);
    expect(container.childElementCount).toBe(0);
  });

  it.each(["readonly", "no-allocation"] as const)("does not query candidates or expose creation for %s views", async kind => {
    const batch = ledger();
    if (kind === "no-allocation") batch.canAllocateSuppliers = false;
    mockFetch(async () => json(batch));
    await renderN09(orderA, kind === "readonly");
    expect(supplierReads()).toHaveLength(0);
    expect(container.querySelector(".external-operation")).toBeNull();
    expect(container.textContent).toContain("TEST 已有台账工厂");
  });

  it("retains the original hidden ledger behavior when the ledger itself returns 403", async () => {
    mockFetch(async () => json({ error: { message: "denied" } }, 403));
    await renderN09();
    expect(container.childElementCount).toBe(0);
    expect(supplierReads()).toHaveLength(0);
  });
});
