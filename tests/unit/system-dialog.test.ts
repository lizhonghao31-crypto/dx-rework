import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const webSourceRoot = "apps/web/src";
const nativeDialogCall = /(?<![.\w$])(?:window\s*\.\s*|globalThis\s*\.\s*)?(?:alert|confirm|prompt)\s*\(/g;

const collectSourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  }));
  return files.flat().sort();
};

describe("system dialog automation contract", () => {
  it("renders an accessible in-page dialog with stable automation controls", async () => {
    const source = await readFile("apps/web/src/system-dialog.tsx", "utf8");
    const css = await readFile("apps/web/src/system-dialog.css", "utf8");

    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain('data-system-dialog-confirm="true"');
    expect(source).toContain('data-system-dialog-cancel="true"');
    expect(source).toContain('data-system-dialog-input="true"');
    expect(source).toContain("if (completed) return");
    expect(source).toContain('request.kind === "prompt"');
    expect(source).toContain("mountNextDialog");
    expect(css).toContain(".system-dialog-backdrop");
    expect(css).toContain("background: #fff;");
    expect(css).toContain("box-shadow: 0 20px 52px");
    expect(css).toContain(".system-dialog__actions .dx-button");
    expect(css).toContain("@media (max-width: 520px)");
  });

  it("forbids browser-native dialogs across the web application", async () => {
    const files = await collectSourceFiles(webSourceRoot);
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (nativeDialogCall.test(source)) offenders.push(file);
      nativeDialogCall.lastIndex = 0;
    }

    expect(offenders).toEqual([]);
  });

  it("uses the shared dialog in the unattended acceptance workflow", async () => {
    const sources = await Promise.all([
      readFile("apps/web/src/rework-form.tsx", "utf8"),
      readFile("apps/web/src/process-configuration-form.tsx", "utf8"),
      readFile("apps/web/src/whole-order-review-panel.tsx", "utf8"),
      readFile("apps/web/src/responsibility-determination-panel.tsx", "utf8"),
    ]);

    expect(sources[0]).toContain('await confirmInApp("确认提交返工单？")');
    expect(sources[1]).toContain('await confirmInApp("确认提交当前工序与候选单价给 IE 核价，并立即分配尾查？")');
    expect(sources[2]).toContain("await confirmInApp");
    expect(sources[2]).toContain("await promptInApp");
    expect(sources[3]).toContain("await confirmInApp");
  });

  it("keeps custom report and image dialogs on the same clean overlay treatment", async () => {
    const [reportingCss, detailCss] = await Promise.all([
      readFile("apps/web/src/work-reporting-form.css", "utf8"),
      readFile("apps/web/src/rework-detail.css", "utf8"),
    ]);
    expect(reportingCss).toContain(".work-reporting-dialog-backdrop");
    expect(reportingCss).toContain("z-index: 1000;");
    expect(reportingCss).toContain("background: #fff;");
    expect(detailCss).toContain(".rework-image-modal__content");
    expect(detailCss).toContain("box-shadow: 0 20px 52px");
  });
});
