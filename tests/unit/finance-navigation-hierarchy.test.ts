import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { financeNavigationEntries, financePageRequirements } from "../../apps/web/src/finance-access.js";
import { NavigationGroupMenu } from "../../apps/web/src/components.js";

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
    const positions = ["订单打板", "外发定价&选厂", "订单返工", "供应商中心", "样衣管理", "financeGroup", "平台管理"].map(name => groups.indexOf(name));
    expect(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1]!))).toBe(true);
    expect(shell).toContain("<NavigationGroupMenu group={financeGroup}");
  });
});
