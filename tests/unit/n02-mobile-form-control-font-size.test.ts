import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("N02 mobile form control font size", () => {
  it("keeps N02 text-entry controls at 16px without changing other pages or disabling manual zoom", async () => {
    const [globalStyles, n02Styles, html] = await Promise.all([
      readFile("apps/web/src/styles.css", "utf8"),
      readFile("apps/web/src/process-worker-assignment-mobile-sheet.css", "utf8"),
      readFile("apps/web/index.html", "utf8"),
    ]);

    expect(n02Styles).toContain('.process-worker-page input:not([type="checkbox"]):not([type="radio"]):not([type="file"])');
    expect(n02Styles).toContain('.process-worker-page select,\n  .process-worker-page textarea{font-size:16px!important}');
    expect(globalStyles).not.toContain('input:not([type="checkbox"]):not([type="radio"]):not([type="file"])');
    expect(html).not.toContain("user-scalable=no");
    expect(html).not.toContain("maximum-scale=1");
  });
});
