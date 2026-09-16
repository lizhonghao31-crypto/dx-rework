import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("supplier module navigation separation", () => {
  it("keeps directory and maintenance as Shell navigation modules instead of page-local tabs", async () => {
    const [shell, page, navigationCss] = await Promise.all([
      readFile("apps/web/src/components.tsx", "utf8"),
      readFile("apps/web/src/supplier-center-page.tsx", "utf8"),
      readFile("apps/web/src/supplier-module-navigation.css", "utf8"),
    ]);

    expect(shell).toContain('name: "供应商目录"');
    expect(shell).toContain('href: "/ui/suppliers"');
    expect(shell).toContain('name: "资料维护"');
    expect(shell).toContain('href: "/ui/suppliers/manage"');
    expect(shell).toContain("supplierGroup={supplierGroup}");
    expect(shell).toContain("<NavigationGroupMenu group={supplierGroup}");
    expect(shell).not.toContain("mobileSupplierNavigation");

    expect(page).not.toContain("SupplierCenterNavigation");
    expect(page).not.toContain("supplier-center-tabs");
    expect(page).toContain("返回列表");
    expect(page).not.toContain(">返回目录</Button>");

    expect(navigationCss).toContain('a[href$="/ui/suppliers"]');
    expect(navigationCss).toContain("display: none");
  });
});
