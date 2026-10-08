import { describe, expect, it } from "vitest";
import type { DigitalOrder, DigitalSource } from "../../packages/contracts/src/digital-production.js";
import { canAttachHistoricalSource, digitalDetailClosePath, digitalDetailReturnUrl, digitalDetailRoute, digitalLandingPath, historicalSourceCandidates } from "../../apps/web/src/digital-detail-route.js";

const id = "b92e6815-5892-4c51-b3c9-5e70ddbd1546", other = "65566477-088c-418d-8ba2-a655394759b4";
const user = (roles: string[], capabilities: string[] = [], isRoot = false) => ({ id, displayName: "TEST", businessRoles: roles, capabilities, isRoot });
describe("legacy digital detail compatibility", () => {
  it.each(["closure", "factory", "bulk", "instruction", "budget", "development", "task", "order"])("opens exact %s without a homepage", kind => {
    expect(digitalDetailRoute(`?${kind}=${id}`)).toEqual({ kind, id });
  });
  it("keeps domain precedence and closes compound links to their original remaining detail", () => {
    const search = `?budget=${id}&instruction=${other}&instructionVersion=3&task=${id}&taskView=read`;
    expect(digitalDetailRoute(search)).toEqual({ kind: "instruction", id: other, version: 3 });
    const closed = digitalDetailClosePath(search, "/acceptance/")!;
    expect(closed.startsWith("/acceptance/ui/digital-production?")).toBe(true);
    expect(digitalDetailRoute(new URL(closed, "https://local.invalid").search)).toEqual({ kind: "budget", id });
    expect(closed).toContain("taskView=read");
    expect(digitalDetailRoute(`?closure=${id}&budget=invalid`)).toEqual({ kind: "closure", id });
  });
  it.each([["instruction", "instructionVersion"], ["budget", "budgetVersion"], ["development", "round"]])("preserves %s history and rejects malformed history", (kind, version) => {
    expect(digitalDetailRoute(`?${kind}=${id}&${version}=2`)).toEqual({ kind, id, version: 2 });
    for (const value of ["", "0", "-1", "1.5", "abc", "9007199254740992", "1&" + version + "=2"]) expect(digitalDetailRoute(`?${kind}=${id}&${version}=${value}`).kind).toBe("invalid");
  });
  it("does not silently turn malformed exact task links into an editable current task", () => {
    for (const search of [`?task=bad`, `?task=${id}&task=${other}`, `?task=${id}&taskView=unknown`, `?task=${id}&taskView=read&taskView=handle`]) expect(digitalDetailRoute(search).kind).toBe("invalid");
    expect(digitalDetailRoute(`?todo=${other}&task=${id}&taskView=read`)).toEqual({ kind: "task", id });
    expect(digitalDetailRoute("?search=TEST")).toEqual({ kind: "landing" });
  });
  it("lands each role only in an existing authorized workbench", () => {
    expect(digitalLandingPath(user([], [], true))).toBe("ui/digital-cockpit");
    for (const role of ["owner_group", "production_management", "order_merchandiser", "warehouse_receiver", "quality_control"]) expect(digitalLandingPath(user([role]))).toBe("ui/digital-cockpit");
    expect(digitalLandingPath(user(["sample_designer"], ["pattern_room:orders:create"]))).toBe("ui/digital-production?workspace=designer");
    expect(digitalLandingPath(user(["sample_designer"]))).toBe("ui/digital-cockpit");
    expect(digitalLandingPath(user(["finance_read"], ["pattern_room:orders:create"]))).toBeNull();
    expect(digitalLandingPath(user([]))).toBeNull();
  });
  it.each(["/", "/acceptance/"])("retains filtered todo and nested exact task return with base %s", base => {
    const todo = "/ui/my-tasks?q=TEST&module=digital_production&page=3";
    const task = `/ui/digital-production?task=${id}&taskView=read&todo=${other}&returnTo=${encodeURIComponent(todo)}`;
    const returned = digitalDetailReturnUrl(task, base)!;
    const parsed = new URL(returned, "https://local.invalid");
    expect(parsed.pathname).toBe(base + "ui/digital-production");
    expect(parsed.searchParams.get("task")).toBe(id);
    expect(parsed.searchParams.get("taskView")).toBe("read");
    expect(parsed.searchParams.get("todo")).toBe(other);
    expect(parsed.searchParams.get("returnTo")).toBe(base + todo.slice(1));
    expect(digitalDetailClosePath(`?development=${other}&round=2&returnTo=${encodeURIComponent(task)}`, base)).toBe(returned);
    expect(digitalDetailClosePath(parsed.search, base)).toBe(base + todo.slice(1));
  });
  it("preserves selected source, cockpit page, search and preparation workspace", () => {
    const designer = `/acceptance/ui/digital-production?workspace=designer&selected=${id}&page=2`;
    expect(digitalDetailReturnUrl(designer, "/acceptance/")).toBe(designer);
    const cockpit = `/ui/digital-cockpit?search=TEST&page=3&selected=${id}&workspace=preparation`;
    const back = new URL(digitalDetailReturnUrl(cockpit, "/acceptance/")!, "https://local.invalid");
    expect(back.pathname).toBe("/acceptance/ui/digital-cockpit");
    for (const [key, value] of Object.entries({ search: "TEST", page: "3", selected: id, workspace: "preparation" })) expect(back.searchParams.get(key)).toBe(value);
  });
  it("returns a child document to its exact historical mother record", () => {
    const mother = `/ui/digital-production?order=${id}`;
    expect(digitalDetailClosePath(`?budget=${id}&returnTo=${encodeURIComponent(mother)}`, "/")).toBe(mother);
    expect(digitalDetailClosePath(`?order=${id}`, "/")).toBeNull();
  });
  it("rejects ambiguous outer return targets and falls back to the remaining native detail", () => {
    const returns = `returnTo=${encodeURIComponent("/ui/my-tasks?q=first&page=2")}&returnTo=${encodeURIComponent("/ui/my-tasks?q=second&page=3")}`;
    expect(digitalDetailClosePath(`?task=${id}&${returns}`, "/")).toBeNull();
    expect(digitalDetailClosePath(`?budget=${id}&order=${other}&${returns}`, "/acceptance/")).toBe(`/acceptance/ui/digital-production?order=${other}`);
    expect(digitalDetailClosePath(`?task=${id}&returnTo=&returnTo=${encodeURIComponent("/ui/my-tasks")}`, "/")).toBeNull();
  });
  it.each(["https://outside.test/", "//outside.test/ui/my-tasks", "/\\outside.test", "/ui/my-tasks#fragment", "/ui/my-tasks?page=2&page=3", "/ui/digital-production?order=bad", `/ui/digital-production?task=${id}&taskView=oops`, `/ui/digital-production?task=${id}&returnTo=${encodeURIComponent(`/ui/digital-production?task=${other}`)}`, `/ui/digital-production?order=${id}&returnTo=https%3A%2F%2Foutside.test`])("rejects unsafe or recursive return %s", value => {
    expect(digitalDetailReturnUrl(value, "/")).toBeNull();
  });
  it("retains original source-less historical attach eligibility and exact source compatibility", () => {
    const order = { productionOrderId: id, sourceId: null, createdBy: id, designStyleNo: "TEST", temporaryStyleNo: "TEMP", customerCode: "PD" } as DigitalOrder;
    const access = { manage: false, customers: false, approveDelivery: false, create: true, actorId: id, roles: ["sample_designer"] };
    expect(canAttachHistoricalSource(order, access)).toBe(true);
    expect(canAttachHistoricalSource(order, { ...access, actorId: other })).toBe(false);
    expect(canAttachHistoricalSource(order, { ...access, roles: ["order_merchandiser"] })).toBe(false);
    expect(canAttachHistoricalSource(order, { ...access, actorId: other, manage: true })).toBe(true);
    expect(canAttachHistoricalSource({ ...order, sourceId: other }, { ...access, manage: true })).toBe(false);
    const source = { sourceId: other, createdBy: id, designStyleNo: "TEST", temporaryStyleNo: "TEMP", customerCode: "PD", productionOrderId: null, developmentType: "头版", createdAt: "2026-10-08T00:00:00Z" } as DigitalSource;
    const invalid = [{ createdBy: other }, { designStyleNo: "other" }, { temporaryStyleNo: null }, { customerCode: "GM" }, { productionOrderId: id }].map(patch => ({ ...source, ...patch }));
    expect(historicalSourceCandidates(order, [source, ...invalid])).toEqual([source]);
    expect(historicalSourceCandidates(order, [{ ...source, customerCode: null }])).toHaveLength(1);
  });
});
