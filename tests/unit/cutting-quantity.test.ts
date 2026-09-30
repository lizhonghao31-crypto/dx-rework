import { describe, expect, it } from "vitest";

import {
  CorrectCuttingRecordSchema,
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

  it("keeps piece count and actual cut count independent while requiring 1-3 cutting-sheet images", () => {
    const first = "00000000-0000-4000-8000-000000000001";
    const second = "00000000-0000-4000-8000-000000000002";
    const third = "00000000-0000-4000-8000-000000000003";
    const fourth = "00000000-0000-4000-8000-000000000004";
    expect(CreateCuttingRecordSchema.parse({
      pieceCount: 7000,
      actualCutCount: 1000,
      attachmentIds: [first],
    })).toEqual({ pieceCount: 7000, actualCutCount: 1000, attachmentIds: [first] });
    expect(CreateCuttingRecordSchema.parse({
      pieceCount: 0,
      actualCutCount: 0,
      attachmentIds: [first, second, third],
    })).toEqual({ pieceCount: 0, actualCutCount: 0, attachmentIds: [first, second, third] });
    expect(() => CreateCuttingRecordSchema.parse({
      pieceCount: 1, actualCutCount: 1, attachmentIds: [],
    })).toThrow();
    expect(() => CreateCuttingRecordSchema.parse({
      pieceCount: 1, actualCutCount: 1, attachmentIds: [first, second, third, fourth],
    })).toThrow();
    expect(() => CreateCuttingRecordSchema.parse({
      pieceCount: 1, actualCutCount: 1, attachmentIds: [first, first],
    })).toThrow();
    expect(CorrectCuttingRecordSchema.parse({
      pieceCount: 1, actualCutCount: 1, expectedVersion: 1, reason: "修正数量",
    })).not.toHaveProperty("attachmentIds");
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
