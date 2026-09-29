import { expect, it } from "vitest";
import { digitalDeadline, digitalTaskTiming } from "../../packages/domain/src/digital-task-deadline.js";
it("keeps continuous time across Sunday and lunch with exact boundary classification", () => {
  const deadline = digitalDeadline("2026-09-26T23:00:00+08:00", 4*3600, 0.8);
  expect(deadline.dueAt!.toISOString()).toBe("2026-09-26T19:00:00.000Z");
  expect(digitalDeadline("2026-09-27T11:00:00+08:00", 4*3600, 0.8).dueAt!.toISOString()).toBe("2026-09-27T07:00:00.000Z");
  expect(digitalTaskTiming({ slaHours: 4, enteredAt: "2026-09-26T15:00:00Z", completedAt: null, terminal: false, dueAt: deadline.dueAt!.toISOString(), warningAt: deadline.warningAt!.toISOString() }, deadline.dueAt!).state).toBe("overdue");
});
it("does not invent a deadline or on-time score for no-SLA and unknown time", () => {
  expect(digitalDeadline("2026-09-29T00:00:00Z", null, 0.8)).toEqual({ warningAt: null, dueAt: null });
  expect(digitalDeadline(null, 4*3600, 0.8)).toEqual({ warningAt: null, dueAt: null });
  expect(digitalTaskTiming({ slaHours: null, enteredAt: "2026-09-29T00:00:00Z", completedAt: null, terminal: false, dueAt: null, warningAt: null }, new Date("2026-09-29T05:00:00Z"))).toEqual({ state: "unlimited", elapsedSeconds: 18000, onTime: null });
});

it("distinguishes unknown SLA entry from intentionally unlimited work",()=>{
  for(const terminal of [false,true]) expect(digitalTaskTiming({slaHours:4,enteredAt:null,completedAt:terminal?"2026-09-29T05:00:00Z":null,terminal,dueAt:null,warningAt:null},new Date())).toMatchObject({state:"unknown",elapsedSeconds:null,onTime:null});
});
