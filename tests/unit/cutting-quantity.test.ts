import { describe, expect, it } from "vitest";

import {
  CreateCuttingRecordSchema,
  cuttingAllowedRange,
  cuttingOutOfRange,
  parseCuttingCountText,
} from "@dx-rework/contracts";

describe("cutting quantity rules", () => {
  it("accepts only complete non-negative integer text without silent coercion", () => {
    expect(parseCuttingCountText("")).toBeNull();
    expect(parseCuttingCountText("0")).toBe(0);
    expect(parseCuttingCountText("1")).toBe(1);
    expect(parseCuttingCountText("001")).toBe(1);
    expect(parseCuttingCountText("-1")).toBeNull();
    expect(parseCuttingCountText("1.5")).toBeNull();
    expect(parseCuttingCountText("15件")).toBeNull();
    expect(parseCuttingCountText("1e3")).toBeNull();
    expect(parseCuttingCountText("Infinity")).toBeNull();
  });

  it("keeps piece count and actual cut count independent", () => {
    expect(CreateCuttingRecordSchema.parse({
      pieceCount: 7000,
      actualCutCount: 1000,
    })).toEqual({ pieceCount: 7000, actualCutCount: 1000 });
    expect(CreateCuttingRecordSchema.parse({
      pieceCount: 0,
      actualCutCount: 0,
    })).toEqual({ pieceCount: 0, actualCutCount: 0 });
  });

  it("uses exact inclusive five-percent boundaries", () => {
    expect(cuttingAllowedRange(1000)).toEqual({ min: 950, max: 1050 });
    for (const value of [950, 1000, 1050]) {
      expect(cuttingOutOfRange(1000, value)).toBe(false);
    }
    for (const value of [949, 1051]) {
      expect(cuttingOutOfRange(1000, value)).toBe(true);
    }

    expect(cuttingAllowedRange(101)).toEqual({ min: 96, max: 106 });
    expect(cuttingOutOfRange(101, 95)).toBe(true);
    expect(cuttingOutOfRange(101, 96)).toBe(false);
    expect(cuttingOutOfRange(101, 106)).toBe(false);
    expect(cuttingOutOfRange(101, 107)).toBe(true);
  });
});
