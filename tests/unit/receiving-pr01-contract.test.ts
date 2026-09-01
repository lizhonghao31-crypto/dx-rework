import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("PR-01 receiving fact layer", () => {
  it("keeps warehouse receiving to one simple mobile form with searchable style numbers", async () => {
    const page = await read("apps/web/src/receiving-page.tsx");
    expect(page).toContain("＋");
    expect(page).toContain("点击收货");
    expect(page).toContain("款号");
    expect(page).toContain("搜索或填写款号");
    expect(page).toContain("送货单数量");
    expect(page).toContain("实际收货数量");
    expect(page).toContain("提交收货");
    expect(page).not.toContain("订单跟单");
    expect(page).not.toContain("供应商");
    expect(page).not.toContain("下一步");
  });

  it("records immutable receiving facts and gives Root the same receiving path", async () => {
    const [migration, routes, auth] = await Promise.all([
      read("apps/api/migrations/0076_receiving_fact_layer.sql"),
      read("apps/api/src/receiving/receiving-routes.ts"),
      read("apps/web/src/auth.tsx"),
    ]);
    expect(migration).toContain("'warehouse_receiver','仓管人员'");
    expect(migration).toContain("'receiving:create'");
    expect(migration).toContain("GENERATED ALWAYS AS (actual_quantity-document_quantity) STORED");
    expect(migration).toContain("receiving_receipts_no_update");
    expect(migration).toContain("receiving_receipts_no_delete");
    expect(routes).toContain("await isRootUser(dependencies.root, user.id)");
    expect(routes).toContain('"receiving:create"');
    expect(routes).toContain('"/receiving/repeat-options"');
    expect(routes).toContain("await creator(request);");
    expect(routes).toContain("dependencies.service.listRepeatOptions");
    expect(routes).toContain('"/receiving/repeat-receipts"');
    expect(routes).toContain("dependencies.service.createRepeated");
    expect(routes).toContain("idempotencyKey(request)");
    expect(auth).toContain("if (user.isRoot === true) return true");
  });

  it("separates the receiving order board from the rework order board", async () => {
    const [app, navigation, board, boardCss] = await Promise.all([
      read("apps/web/src/App.tsx"),
      read("apps/web/src/components.tsx"),
      read("apps/web/src/order-board-page.tsx"),
      read("apps/web/src/order-board-page.css"),
    ]);
    expect(app).toContain('path === "/ui/orders"');
    expect(app).toContain('path === "/ui/receiving"');
    expect(navigation).toContain('name: "订单回货"');
    expect(navigation).toContain('name: "返工单看板"');
    expect(board).toContain("少收订单默认置顶");
    expect(board).toContain("收货订单");
    expect(board).toContain("实际收货");
    expect(board).toContain("差异率");
    expect(boardCss).toContain(".order-board-row.is-short");
    expect(boardCss).toContain(".order-board-row.is-extra");
    expect(boardCss).toContain(".order-board-row.is-even");
  });

  it("keeps the mobile facts compact while placing rework beside the style label", async () => {
    const [board, boardCss] = await Promise.all([
      read("apps/web/src/order-board-page.tsx"),
      read("apps/web/src/order-board-page.css"),
    ]);
    expect(board).toContain(
      '<div className="order-board-row__style-heading"><span>款号</span>{reworkControl(row)}</div>',
    );
    expect(board).toContain('className="order-board-history-toggle"');
    expect(boardCss).toContain("grid-template-columns:repeat(3,minmax(0,1fr))!important");
    expect(boardCss).toContain(
      ".order-board-row__style-heading>span,.order-board-row__style-heading>.order-board-rework-link{font-size:10px",
    );
    expect(boardCss).toContain(".order-board-history{display:grid;width:100%");
  });
});
