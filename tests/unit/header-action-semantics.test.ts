import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("header action semantics", () => {
  it("renders navigation actions as links without nesting a button", async () => {
    const source = await readFile("apps/web/src/components.tsx", "utf8");

    expect(source).toContain(
      '<a className="dx-button dx-button--secondary header-action-link" href={resolvedActionHref}>{action}</a>',
    );
    expect(source).not.toContain("<a href={resolvedActionHref}><Button>");
  });
});
