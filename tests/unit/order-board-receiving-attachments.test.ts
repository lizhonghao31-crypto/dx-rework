import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("order board receiving attachments", () => {
  it("keeps receipt evidence inside the receiving-document field and loads images only on demand", async () => {
    const [service, page, server, styles] = await Promise.all([
      readFile("apps/api/src/receiving/receiving-service.ts", "utf8"),
      readFile("apps/web/src/order-board-page.tsx", "utf8"),
      readFile("apps/api/src/server.ts", "utf8"),
      readFile("apps/web/src/order-board-page.css", "utf8"),
    ]);

    expect(service).toContain("COALESCE(receiving_attachments.items,'[]'::jsonb) AS receiving_attachments");
    expect(service).toContain("attachment.entity_type='receiving_batch'");
    expect(service).toContain("attachment.mime_type LIKE 'image/%'");
    expect(page).toContain('className="order-board-row__document-value"');
    expect(page).toContain("查看{row.attachments.length > 1");
    expect(page).toContain('attachmentUrl(selectedAttachment.attachmentId, "preview")');
    expect(page).not.toContain("<span>送货单</span>");
    expect(server).not.toContain('["rework_order", "receiving_batch"].includes(binding.entityType)');
    expect(server).toContain("receivingService.canDownloadBoundAttachment(businessReader, binding)");
    expect(server).toContain("reworkBusinessDetailService.canDownloadBoundAttachment(businessReader, binding)");
    expect(styles).toContain(".order-board-row__document-value{display:flex");
  });
});
