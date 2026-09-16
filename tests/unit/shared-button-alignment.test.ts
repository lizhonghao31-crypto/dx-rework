import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("shared button alignment", () => {
  it("centers standard button and link-button content without overriding disclosure semantics", async () => {
    const [components, polish, supplier] = await Promise.all([
      readFile("packages/ui/src/components.css", "utf8"),
      readFile("apps/web/src/ui-polish.css", "utf8"),
      readFile("apps/web/src/supplier-center-page.css", "utf8"),
    ]);

    const sharedButtonRule = components.match(/\.dx-button\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(sharedButtonRule).toContain("display: inline-flex");
    expect(sharedButtonRule).toContain("align-items: center");
    expect(sharedButtonRule).toContain("justify-content: center");
    expect(sharedButtonRule).toContain("text-align: center");

    const disclosureRule = polish.match(/\.ui-polish \.dx-button\.ui-disclosure-trigger\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(disclosureRule).toContain("justify-content: flex-start");
    expect(disclosureRule).toContain("text-align: left");

    expect(supplier).not.toMatch(/\.supplier-profile__back[^\{]*\{[^\}]*transform\s*:/s);
    expect(supplier).not.toMatch(/\.supplier-profile__back[^\{]*\{[^\}]*top\s*:/s);
  });
});
