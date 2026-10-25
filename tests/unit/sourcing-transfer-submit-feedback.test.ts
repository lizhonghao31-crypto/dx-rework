import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import type * as ReactModule from "react";
import { SourcingCaseSummarySchema } from "@dx-rework/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// As in rework-initiation-actions: invoke the real component's handlers without a DOM.
// Initial order data is supplied to the first state cell; submit and load are not mocked.
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as { value: unknown }[], initialItem: undefined as unknown }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof ReactModule>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    const cell = hooks.values[index] ??= { value: index === 0 && hooks.initialItem !== undefined
      ? hooks.initialItem : typeof initial === "function" ? initial() : initial };
    return [cell.value, (value: unknown) => { cell.value = typeof value === "function" ? value(cell.value) : value; }];
  },
  useRef: (initial: unknown) => (hooks.values[hooks.cursor++] ??= { value: { current: initial } }).value,
  useMemo: (compute: () => unknown) => compute(),
  useEffect: () => undefined,
}));
import { SourcingWorkspacePage } from "../../apps/web/src/sourcing-workspace-page.js";

type Props = { children?: ReactNode; onClick?: () => void; onChange?: (event: { target: { value: string } }) => void;
  disabled?: boolean; busy?: boolean; role?: string; value?: unknown };
function elements(node: ReactNode): ReactElement<Props>[] {
  if (!isValidElement<Props>(node)) return [];
  return [node, ...Children.toArray(node.props.children).flatMap(elements)];
}
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const now = "2026-10-24T00:00:00.000Z";
const item = SourcingCaseSummarySchema.parse({
  sourcingCaseId: id(100), erpOrderId: "TEST", erpOrderNo: "TEST", styleNo: "TEST-TRANSFER", laneKey: "garment_processing",
  gender: "女装", styleName: "TEST", orderQuantity: 1000,
  lineItems: [{ position: 1, styleNo: "TEST-TRANSFER", alternateStyleNo: null, color: "蓝", quantity: 1000, externalUnitPrice: null, legacy: false }],
  estimatedCutPieceSendDate: "2026-10-01", deliveryDate: "2026-11-05", processDescription: null, processes: ["TEST-车缝"],
  status: "pending_finance_reconciliation", version: 4, createdBy: id(1), createdAt: now, updatedAt: now,
  ieQuote: null, ownerDecision: null,
  decision: { sourcingDecisionId: id(3), decisionVersion: 2, sourceType: "factory_change", sourceIeQuoteId: null,
    supersedesDecisionId: id(2), supplierId: id(4), supplierCode: "TEST-OLD", supplierName: "TEST原工厂", unitPrice: "12.8",
    quantity: 1000, totalAmount: "12800", linePrices: [{ position: 1, quantity: 1000, unitPrice: "12.8", totalAmount: "12800" }],
    decisionReason: "TEST", decidedBy: id(1), decidedAt: now },
  approvalSnapshot: { sourcingApprovalSnapshotId: id(6), sourcingDecisionId: id(3), decisionVersion: 2,
    supplierId: id(4), supplierCode: "TEST-OLD", supplierName: "TEST原工厂", quantity: 1000, totalAmount: "12800",
    estimatedCutPieceSendDate: "2026-10-01", deliveryDate: "2026-11-05", processes: ["TEST-车缝"],
    linePrices: [{ position: 1, styleNo: "TEST-TRANSFER", alternateStyleNo: null, color: "蓝", quantity: 1000, unitPrice: "12.8", totalAmount: "12800" }],
    approvedBy: id(1), approvedAt: now },
});
const user = { id: id(1), displayName: "TEST root", isRoot: true, businessRoles: ["root_superuser"], capabilities: ["sourcing:view"] };
const contractReturn = { contractReturnMonitoring: false, contractReturnStatus: null, contractGeneratedAt: null,
  contractReturnDueAt: null, contractReturnedAt: null, contractReturnOverdueHours: null, uploadedByName: null, canUpload: false, attachments: [] };

function setup(postFails: boolean) {
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (init?.method === "POST") return postFails
      ? Response.json({ error: { message: "TEST-转厂提交被拒绝", code: "INVALID_STATE_TRANSITION", requestId: "TEST-submit-refused" } }, { status: 409 })
      : Response.json({ ...item, decision: { ...item.decision!, supplierId: id(5), supplierName: "TEST新工厂" } }, { status: 201 });
    if (input.endsWith("/timeline")) return Response.json({ error: { message: "TEST-订单页面刷新失败" } }, { status: 500 });
    if (input.endsWith(`/cases/${id(100)}`)) return Response.json(item);
    if (input.endsWith("/attachments")) return Response.json({ items: [] });
    if (input.endsWith("/dispatch")) return Response.json({ item: null, canDispatch: false });
    if (input.endsWith("/contract-return")) return Response.json(contractReturn);
    return Response.json({ item: null });
  });
  vi.stubGlobal("fetch", fetchMock);
  hooks.cursor = 0; hooks.values = []; hooks.initialItem = undefined;
  const child = elements(SourcingWorkspacePage({ view: "detail", sourcingCaseId: item.sourcingCaseId }))
    .find(node => typeof node.type === "function" && node.type.name === "OrderDetailPage");
  expect(child).toBeDefined();
  const Detail = child!.type as (props: { sourcingCaseId: string; user: typeof user }) => ReactNode;
  hooks.cursor = 0; hooks.values = []; hooks.initialItem = item;
  const render = () => { hooks.cursor = 0; return elements(Detail({ sourcingCaseId: item.sourcingCaseId, user })); };
  const button = (text: string) => render().find(node => node.type === "button" && node.props.children === text)!.props;
  button("订单转厂").onClick!();
  for (const [label, value] of [["新加工厂", id(5)], ["新加工单价", "11.3"], ["转厂原因", "TEST-转厂原因"]]) {
    const field = render().find(node => node.type === "label" && Children.toArray(node.props.children)
      .some(child => isValidElement<Props>(child) && child.type === "span" && child.props.children === label));
    elements(field).find(node => node.props.onChange)?.props.onChange!({ target: { value: value! } });
  }
  expect(button("提交转厂").disabled).toBe(false);
  const busy = () => render().find(node => typeof node.type === "function" && node.type.name === "SourcingPriceReapplicationPanel")!.props.busy;
  return { fetchMock, render, button, busy };
}
beforeEach(() => { vi.stubGlobal("window", { location: { search: "", pathname: "/ui/sourcing/orders/test" } }); });
afterEach(() => { vi.unstubAllGlobals(); hooks.values = []; hooks.initialItem = undefined; });

describe("actual transfer submission and refresh feedback", () => {
  it("retains confirmed success when the following GET fails without a second POST", async () => {
    const { fetchMock, render, button, busy } = setup(false);
    button("提交转厂").onClick!();
    await vi.waitFor(() => expect(render().some(node => node.props.role === "status" && node.props.children === "TEST-订单页面刷新失败")).toBe(true));
    const feedback = render().filter(node => node.props.role === "status");
    expect(feedback.some(node => Children.toArray(node.props.children).includes("老板发起的转厂已直接生效"))).toBe(true);
    expect(render().some(node => node.props.role === "alert")).toBe(false);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== "POST")).toHaveLength(7);
    expect(busy()).toBe(false);
  });
  it("shows a refused POST as failure without attempting a refresh", async () => {
    const { fetchMock, render, button, busy } = setup(true);
    button("提交转厂").onClick!();
    await vi.waitFor(() => expect(render().some(node => node.props.role === "alert" && Children.toArray(node.props.children).includes("TEST-转厂提交被拒绝"))).toBe(true));
    expect(render().some(node => node.props.role === "status" && Children.toArray(node.props.children).includes("老板发起的转厂已直接生效"))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("POST");
    expect(button("提交转厂").disabled).toBe(false);
    expect(busy()).toBe(false);
  });
});
