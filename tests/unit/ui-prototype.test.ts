import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("../../apps/web/src/App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../../apps/web/src/styles.css", import.meta.url), "utf8");

describe("PR-01A UI prototype contract", () => {
  it.each(["/ui/management", "/ui/supervisor", "/ui/tasks", "/ui/tasks/", "/ui/qc/new", "/ui/piecework/collective", "/system/foundation"])("declares route %s", (route) => expect(app).toContain(route));
  it("keeps collective piecework snapshot dynamic and history immutable", () => {
    expect(app).toContain("members.length");
    expect(app).toContain("成员变化创建新版本，历史记录不反算");
    expect(app).not.toContain("写死 7 人");
  });
  it("uses approved tokens and 44px controls", () => {
    expect(css).toContain("--dx-v2-color-bg-canvas:#e8edf2");
    expect(css).toContain("min-height:44px");
  });
});
