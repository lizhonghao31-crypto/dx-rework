import { readFile } from "node:fs/promises";

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { ReceivingService } from "../../apps/api/src/receiving/receiving-service.js";

describe("receiving defective quantity", () => {
  it("rejects a defective count above actual receipt quantity before opening a transaction", async () => {
    const connect = vi.fn();
    const service = new ReceivingService({ connect } as unknown as Pool);

    await expect(service.create({
      actorId: "00000000-0000-4000-8000-000000000001",
      actorRoles: ["warehouse_receiver"],
      authorizationCapability: "receiving:create",
      authorizationCapabilities: ["receiving:create"],
      requestId: "receiving-defective-test",
    }, {
      styleNo: "STYLE-DEFECTIVE",
      documentQuantity: 2,
      actualQuantity: 1,
      defectiveQuantity: 2,
    }, "receiving-defective-key")).rejects.toThrow("次品数量不能超过实际收货数量");

    expect(connect).not.toHaveBeenCalled();
  });

  it("persists, audits, positions and cumulatively displays the new fact", async () => {
    const [migration, routes, service, receivingPage, boardPage, boardStyles] = await Promise.all([
      readFile("apps/api/migrations/0095_receiving_defective_quantity.sql", "utf8"),
      readFile("apps/api/src/receiving/receiving-routes.ts", "utf8"),
      readFile("apps/api/src/receiving/receiving-service.ts", "utf8"),
      readFile("apps/web/src/receiving-page.tsx", "utf8"),
      readFile("apps/web/src/order-board-page.tsx", "utf8"),
      readFile("apps/web/src/order-board-page.css", "utf8"),
    ]);

    expect(migration).toContain("defective_quantity integer NOT NULL DEFAULT 0");
    expect(migration).toContain("defective_quantity<=actual_quantity");
    expect(migration).toContain("defective_quantity_adjustment");
    expect(routes).toContain("body.defectiveQuantity === undefined ? 0");
    expect(service).toContain("defectiveQuantity: input.defectiveQuantity");
    expect(service).toContain("sum(r.defective_quantity)+batch.defective_quantity_adjustment");
    expect(receivingPage.indexOf("<span>次品数量</span>")).toBeGreaterThan(
      receivingPage.indexOf("<span>实际收货数量</span>"),
    );
    expect(receivingPage.indexOf("<span>次品数量</span>")).toBeLessThan(
      receivingPage.indexOf("<span>送货单图片</span>"),
    );
    expect(boardPage).toContain("<span>次品</span><strong>{row.defectiveQuantity}件</strong>");
    expect(boardStyles).toContain("repeat(7,minmax(82px,1fr))");
  });
});
