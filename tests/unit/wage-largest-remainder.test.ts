import { describe, expect, it } from "vitest";

import { allocateLargestRemainder } from "../../apps/api/src/wages/wage-service.js";

const id = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const members = (count: number, exactAmount: string) =>
  Array.from({ length: count }, (_, index) => ({
    personId: id(index + 1),
    exactAmount,
  }));
const totalCents = (values: readonly { payableAmount: string }[]) =>
  values.reduce(
    (sum, value) => sum + BigInt(value.payableAmount.replace(".", "")),
    0n,
  );

describe("wage largest remainder", () => {
  it.each([
    ["10.00", 3, "3.33333333"],
    ["1.00", 7, "0.14285714"],
    ["0.01", 3, "0.00333333"],
  ])("allocates %s across %i people", (total, count, share) => {
    const result = allocateLargestRemainder(total, members(count, share));
    expect(totalCents(result)).toBe(BigInt(total.replace(".", "")));
  });

  it("uses stable person id ordering for equal remainders", () => {
    const result = allocateLargestRemainder("0.01", [
      { personId: id(3), exactAmount: "0.00333333" },
      { personId: id(1), exactAmount: "0.00333333" },
      { personId: id(2), exactAmount: "0.00333333" },
    ]);
    expect(result.find((item) => item.personId === id(1))?.payableAmount)
      .toBe("0.01");
  });

  it("uses rounded group total for an individual task", () => {
    expect(
      allocateLargestRemainder("8.13", members(1, "8.12500000"))[0],
    ).toMatchObject({ payableAmount: "8.13", remainderRank: 1 });
  });

  it("supports forty people and remains deterministic", () => {
    const input = members(40, "0.25000000");
    const first = allocateLargestRemainder("10.00", input);
    expect(first).toEqual(allocateLargestRemainder("10.00", input));
    expect(totalCents(first)).toBe(1000n);
  });

  it("rejects duplicate people", () => {
    expect(() => allocateLargestRemainder("1.00", [
      { personId: id(1), exactAmount: "0.50000000" },
      { personId: id(1), exactAmount: "0.50000000" },
    ])).toThrow("工资份额人员不能重复");
  });

  it("rejects source shares that cannot reconcile to one cent per member", () => {
    expect(() => allocateLargestRemainder(
      "1.10",
      members(2, "0.50000000"),
    )).toThrow("高精度份额无法按最大余数法对齐组总额");
  });
});
