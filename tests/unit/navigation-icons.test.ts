import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NavigationIcon, navigationIconForRoute } from "../../apps/web/src/navigation-icons.js";

describe("approved navigation icons", () => {
  it("ignores query and hash without guessing unknown or similarly named routes", () => {
    expect(navigationIconForRoute("/ui/samples/?status=active#list")).toBe("Shirt");
    expect(navigationIconForRoute("/ui/samples/amounts")).toBe("ChartColumn");
    expect(navigationIconForRoute("/ui/samples-archive")).toBeUndefined();
    expect(navigationIconForRoute("/ui/unknown")).toBeUndefined();
  });

  it("keeps decorative icons out of accessible names and keyboard focus", () => {
    const html = renderToStaticMarkup(createElement(NavigationIcon, { route: "/ui/suppliers", size: "primary" }));
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('focusable="false"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain("dx-navigation-icon--primary");
    expect(html).not.toContain("<title");
  });

  it("uses a known module for detail headings and renders no icon for unknown pages", () => {
    expect(renderToStaticMarkup(createElement(NavigationIcon, { route: "/ui/unknown" }))).toBe("");
    const detail = renderToStaticMarkup(createElement(NavigationIcon, { route: "/ui/samples/example", group: "样衣管理", size: "title" }));
    const module = renderToStaticMarkup(createElement(NavigationIcon, { route: "/ui/samples", size: "title" }));
    expect(detail).toBe(module);
  });
});
