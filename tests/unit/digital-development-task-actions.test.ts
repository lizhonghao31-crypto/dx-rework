import { describe, expect, it } from "vitest";
import { DIGITAL_TASK_ROLES } from "../../apps/api/src/production-platform/task-access-repository.js";
import { developmentTaskNeedsBusinessPage } from "../../apps/web/src/digital-development-task-actions.js";

describe("development business action entry", () => {
  it("covers every currently declared development node", () => {
    const kinds = Object.keys(DIGITAL_TASK_ROLES).filter(kind => kind.startsWith("development_"));
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) expect(developmentTaskNeedsBusinessPage(kind), kind).toBe(true);
  });

  it("does not classify other or unknown nodes as development business actions", () => {
    for (const kind of [...Object.keys(DIGITAL_TASK_ROLES).filter(kind => !kind.startsWith("development_")), "development_unknown", "unknown"]) {
      expect(developmentTaskNeedsBusinessPage(kind), kind).toBe(false);
    }
  });
});
