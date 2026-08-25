import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("mobile role layout and rework image consistency", () => {
  it("keeps compiled CSS compatible with older DingTalk WebViews", async () => {
    const vite = await read("apps/web/vite.config.ts");
    expect(vite).toContain('cssTarget: "chrome61"');
  });

  it("shows style number, RW number and images without the retired order-number copy", async () => {
    const [page, form, service, contract] = await Promise.all([
      read("apps/web/src/frontline-task-page.tsx"),
      read("apps/web/src/work-reporting-form.tsx"),
      read("apps/api/src/rework/work-reporting-service.ts"),
      read("packages/contracts/src/index.ts"),
    ]);
    expect(page).toContain('className="frontline-task-images"');
    expect(page).toContain('item.reworkNo ?? "返工单号待生成"');
    expect(form).toContain('frontlineContext.reworkNo ?? "返工单号待生成"');
    expect(page).not.toContain("订单号未填写");
    expect(form).not.toContain("订单号未填写");
    expect(service).toContain("attachment.mime_type LIKE 'image/%'");
    expect(contract).toContain("images: z.array(z.object({");
  });

  it("opens only rework-order images to every authenticated effective role", async () => {
    const [routes, attachments, server] = await Promise.all([
      read("apps/api/src/tools/routes.ts"),
      read("apps/api/src/tools/attachments.ts"),
      read("apps/api/src/server.ts"),
    ]);
    expect(routes).toContain("entityId:string;mimeType:string");
    expect(attachments).toContain("mimeType: row.mime_type");
    expect(server).toContain('binding.entityType === "rework_order" && binding.mimeType.startsWith("image/")');
    expect(server).not.toContain('binding.entityType === "rework_order") return true');
  });
});
