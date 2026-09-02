import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("mobile sourcing workspace", () => {
  it("renders the real role-scoped business pages instead of a desktop-only blocker", async () => {
    const page = await readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8");

    expect(page).not.toContain("isMobileClient");
    expect(page).not.toContain("该模块当前仅开放电脑端");
    expect(page).not.toContain("请在电脑端打开");
    expect(page).toContain('view === "create" ? <CreateOrderPage');
    expect(page).toContain('view === "pending" ? <OrderListPage');
    expect(page).toContain('view === "history" ? <OrderListPage');
    expect(page).toContain('view === "detail" && sourcingCaseId');
    expect(page).toContain('canAct(user, "order_merchandiser", "sourcing:inquiry:create")');
    expect(page).toContain('canAct(user, "ie_reviewer", "sourcing:price:quote")');
    expect(page).toContain('canAct(user, "production_management", "sourcing:decision:record")');
    expect(page).toContain('canAct(user, "owner_group", "sourcing:owner:approve")');
    expect(page).toContain('canAct(user, "factory_payables", "sourcing:finance:reconcile")');
  });

  it("uses a 390px-safe single-column layout without reducing craft entry to one item", async () => {
    const [page, css] = await Promise.all([
      readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8"),
      readFile("apps/web/src/sourcing-workspace.css", "utf8"),
    ]);

    expect(page).toContain('className="sourcing-process-editor sourcing-form-wide"');
    expect(page).toContain("processes.map((process, index)");
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toContain(".sourcing-process-mobile {\n    display: none;");
    expect(css).toContain(".sourcing-process-editor {\n    display: grid;");
    expect(css).toContain(".sourcing-form-grid {\n    grid-template-columns: minmax(0, 1fr);");
    expect(css).toContain(".sourcing-order-card__main {\n    grid-template-columns: minmax(0, 1fr);");
    expect(css).toContain(".sourcing-order-detail .rework-detail-core-facts {");
    expect(css).toContain(".sourcing-finance-reference {\n    display: grid;");
    expect(css).toContain("env(safe-area-inset-bottom, 0px)");
  });
});
