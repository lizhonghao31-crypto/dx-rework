import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { financeNavigationEntries, financePageRequirements } from "../../apps/web/src/finance-access.js";
import { DesktopNavigation, NavigationGroupMenu } from "../../apps/web/src/components.js";

describe("finance secondary navigation", () => {
  it("shows a wage accountant an expandable finance group with a direct wage child", () => {
    const user = { id: "accountant", displayName: "工资会计", businessRoles: ["wage_month_close_accountant"], capabilities: ["wage:view", "wage:export"] };
    const entries = financeNavigationEntries(user);
    expect(entries.map(entry => entry.href)).toEqual(["/ui/wages"]);
    expect(financePageRequirements).toContainEqual({ requiredRole: "wage_month_close_accountant", requiredCapability: "wage:view" });
    const html = renderToStaticMarkup(createElement(NavigationGroupMenu, { group: { name: "财务中心", description: "财务资料与工资", entries }, active: "工资管理", basePath: "/rework" }));
    expect(html).toMatch(/<details[^>]*open=""/);
    expect(html).toContain("财务中心</strong>");
    expect(html).toContain('href="/rework/ui/wages"');
    expect(html).toContain("工资管理</strong>");
    expect(html).not.toContain('href="/rework/ui/finance"');
  });
  it("does not turn a menu relocation into a new financial grant", () => {
    expect(financeNavigationEntries(null)).toEqual([]);
    expect(financeNavigationEntries({ id: "a", displayName: "工资会计", businessRoles: ["worker"], capabilities: ["wage:view"] })).toEqual([]);
    expect(financeNavigationEntries({ id: "a", displayName: "会计", businessRoles: ["wage_month_close_accountant"], capabilities: [] })).toEqual([]);
    expect(financeNavigationEntries({ id: "root", displayName: "Root", isRoot: true, capabilities: [] })).toHaveLength(1);
  });
  it("preserves legacy routes and the requested group order without a module selection page", async () => {
    const app = await readFile("apps/web/src/App.tsx", "utf8");
    expect(app).toContain('path === "/ui/finance" || path === "/ui/wages" || path.startsWith("/ui/wages/")');
    expect(app).toContain('<Shell active="工资管理"><WagePage path={path} /></Shell>');
    expect(app).not.toContain("FinancePage");
    const shell = await readFile("apps/web/src/components.tsx", "utf8");
    const groups = shell.slice(shell.indexOf("const desktopNavigationGroups"), shell.indexOf("const roleLabels"));
    const positions = ["设计开发工作台", "产品开发打板", "大货产前准备", "外发定价&选厂", "订单开裁", "裁后工艺与发厂", "订单返工", "供应商中心", "样衣管理", "financeGroup", "平台管理"].map(name => groups.indexOf(name));
    expect(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1]!))).toBe(true);
    expect(shell).toContain("<NavigationGroupMenu group={financeGroup}");
  });
});

describe("desktop preparation quotation navigation", () => {
  const quotation = { name: "客户报价协作", description: "按原分工报价", href: "/ui/digital-quotation", activeKey: "customer-quote" };
  const otherDestination = { name: "其他准备入口", description: "原组的其他目的地", href: "/ui/preparation-other", activeKey: "preparation-other" };

  function renderDesktop(entries: readonly (typeof quotation)[], active: string) {
    const html = renderToStaticMarkup(createElement(DesktopNavigation, {
      globalNavigation: [], active, basePath: "/rework", pendingTodoCount: 0,
      groups: [
        { name: "产品开发打板", description: "按原顺序", entries: [otherDestination] },
        { name: "大货产前准备", description: "生产前置汇合", entries },
        { name: "外发定价&选厂", description: "按原顺序", entries: [otherDestination] },
      ],
    }));
    const doc = JSDOM.fragment(html);
    return Array.from(doc.querySelectorAll(".desktop-navigation > :not(.desktop-navigation__global)"));
  }

  it("renders one original quotation link in its desktop group position with a single focus stop", () => {
    const [previous, direct, next] = renderDesktop([quotation], quotation.activeKey);
    expect(previous?.querySelector("summary")?.textContent).toContain("产品开发打板");
    expect(next?.querySelector("summary")?.textContent).toContain("外发定价&选厂");
    expect(direct?.querySelectorAll("a[href],summary,[tabindex]")).toHaveLength(1);
    const link = direct?.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/rework/ui/digital-quotation");
    expect(link?.textContent).toContain("大货产前准备");
    expect(link?.textContent).toContain("客户报价协作");
    expect(link?.getAttribute("aria-current")).toBe("page");
    expect(link?.querySelector(".dx-nav-item")?.classList.contains("is-active")).toBe(true);
    expect(renderDesktop([quotation], "其他页面")[1]?.querySelector("a")?.hasAttribute("aria-current")).toBe(false);
  });

  it("preserves the hidden desktop preparation group when no destination is authorized", () => {
    const shown = renderDesktop([], "其他页面");
    expect(shown).toHaveLength(2);
    expect(shown.every(group => group.tagName === "DETAILS")).toBe(true);
    expect(shown.map(group => group.querySelector("summary strong")?.textContent)).toEqual(["产品开发打板", "外发定价&选厂"]);
  });

  it("keeps the original disclosure for two authorized destinations or a different destination", () => {
    const group = renderDesktop([quotation, otherDestination], otherDestination.activeKey)[1];
    expect(group?.tagName).toBe("DETAILS");
    expect(group?.hasAttribute("open")).toBe(true);
    expect(group?.querySelector("summary strong")?.textContent).toBe("大货产前准备");
    expect(Array.from(group?.querySelectorAll("a[href]") ?? [], link => link.getAttribute("href"))).toEqual([
      "/rework/ui/digital-quotation", "/rework/ui/preparation-other",
    ]);
    expect(group?.querySelector('a[aria-current="page"]')?.getAttribute("href")).toBe("/rework/ui/preparation-other");
    expect(renderDesktop([otherDestination], "其他页面")[1]?.tagName).toBe("DETAILS");
  });
});
