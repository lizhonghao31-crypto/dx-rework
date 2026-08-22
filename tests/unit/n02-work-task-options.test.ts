import { describe, expect, it } from "vitest";

import { parseWorkTaskOptions } from "../../apps/web/src/work-task-options.js";

const workerId = "00000000-0000-4000-8000-000000000101";
const tailId = "00000000-0000-4000-8000-000000000102";

describe("N02 work-task option payload compatibility", () => {
  it("preserves the current execution-kind response", () => {
    expect(parseWorkTaskOptions({
      people: [{
        personId: tailId,
        displayName: "尾查甲",
        personType: "internal",
        eligibleExecutionKinds: ["tail_inspection"],
      }],
    })).toEqual({
      response: {
        people: [{
          personId: tailId,
          displayName: "尾查甲",
          personType: "internal",
          eligibleExecutionKinds: ["tail_inspection"],
        }],
      },
      compatibilityMode: false,
    });
  });

  it("restores server-filtered workers from the previous API shape during a rolling deployment", () => {
    expect(parseWorkTaskOptions({
      people: [{
        personId: workerId,
        displayName: "正式工甲",
        personType: "internal",
      }],
    })).toEqual({
      response: {
        people: [{
          personId: workerId,
          displayName: "正式工甲",
          personType: "internal",
          eligibleExecutionKinds: ["worker"],
        }],
      },
      compatibilityMode: true,
    });
  });

  it("never infers tail-inspection eligibility from an old payload", () => {
    const parsed = parseWorkTaskOptions({
      people: [{
        personId: workerId,
        displayName: "正式工甲",
        personType: "internal",
      }],
    });
    expect(parsed.response.people[0]?.eligibleExecutionKinds).toEqual(["worker"]);
  });

  it("still rejects malformed personnel payloads", () => {
    expect(() => parseWorkTaskOptions({
      people: [{ personId: workerId, displayName: "", personType: "internal" }],
    })).toThrow();
  });
});
