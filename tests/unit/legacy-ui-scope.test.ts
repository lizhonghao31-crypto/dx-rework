import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("apps/web/src/legacy-ui.css", "utf8");

describe("legacy presentation isolation", () => {
  it("cannot target the shell, shared defaults or a page that has not opted in", () => {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = [...withoutComments.matchAll(/([^{}]+)\{/g)].map(match => match[1]!.trim());
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector.startsWith("[data-legacy-ui]")).toBe(true);
    expect(css).not.toMatch(/!important|display:\s*none|pointer-events:\s*none|overflow:\s*hidden/);
  });

  it("keeps the shared responsive control tokens and excludes non-text input semantics", () => {
    expect(css).toContain("var(--dx-form-control-height)");
    expect(css).toContain("var(--dx-form-control-font-size)");
    expect(css).toContain("var(--dx-button-height)");
    for (const type of ["checkbox", "radio", "file", "hidden", "range"]) {
      expect(css).toContain(`:not([type="${type}"])`);
    }
    expect(css).not.toMatch(/(?:^|[;{\s])height:\s*\d+px/);
  });
});
