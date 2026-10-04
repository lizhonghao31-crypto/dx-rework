import { describe, expect, it } from "vitest";
import { notificationActionLift } from "../../apps/web/src/digital-notification-position.js";

describe("desktop notification action avoidance", () => {
  const corner={left:849,right:1149,top:613,bottom:731};
  it("stays in the default corner unless a business action overlaps", () => {
    expect(notificationActionLift(corner,[])).toBe(0);
    expect(notificationActionLift(corner,[{left:327,right:717,top:650,bottom:690}])).toBe(0);
    expect(notificationActionLift(corner,[{left:900,right:1100,top:200,bottom:240}])).toBe(0);
  });
  it("leaves the 1165×747 IE approval and owner rejection action unobstructed", () => {
    const button={left:728,right:1118,top:650,bottom:690};
    const lift=notificationActionLift(corner,[button]);
    expect(corner.bottom-lift).toBe(button.top-8);
    expect(corner.top-lift).toBeGreaterThanOrEqual(72);
  });
  it("avoids several action rows without accumulating lift across measurements", () => {
    const actions=[{left:900,right:1100,top:650,bottom:690},{left:900,right:1100,top:530,bottom:570}];
    const lift=notificationActionLift(corner,actions);
    expect(corner.bottom-lift).toBe(522);
    expect(notificationActionLift(corner,actions)).toBe(lift);
    expect(notificationActionLift(corner,[])).toBe(0);
  });
  it("keeps long messages within the visible page", () => {
    const long={...corner,top:432};
    const lift=notificationActionLift(long,[{left:900,right:1100,top:650,bottom:690}]);
    expect(long.bottom-lift).toBe(642);
    expect(long.top-lift).toBeGreaterThanOrEqual(72);
  });
});
