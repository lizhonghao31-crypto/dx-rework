import { describe, expect, it } from "vitest";

import {
  businessValue,
  formatBusinessCurrency,
  formatBusinessDecimal,
  formatBusinessMoney,
} from "@dx-rework/contracts/business-display";

describe("business number display governance", () => {
  it("groups thousands and removes meaningless trailing zeroes", () => {
    expect(formatBusinessDecimal("2000")).toBe("2,000");
    expect(formatBusinessMoney("4.0000")).toBe("4");
    expect(formatBusinessMoney("4.5000")).toBe("4.5");
    expect(formatBusinessMoney("4.56")).toBe("4.56");
    expect(formatBusinessCurrency("9000.00")).toBe("¥9,000");
  });

  it("rounds ordinary display to two decimals without losing large decimal strings", () => {
    expect(formatBusinessMoney("4.5050")).toBe("4.51");
    expect(formatBusinessMoney("-0.005")).toBe("-0.01");
    expect(formatBusinessMoney("9007199254740993.5")).toBe("9,007,199,254,740,993.5");
    expect(formatBusinessDecimal("1.23456", 4)).toBe("1.2346");
  });

  it("applies the same currency rule to dynamic business values", () => {
    expect(businessValue("amount", "9000.00")).toBe("¥9,000");
    expect(businessValue("roundedAmount", "1234567.891")).toBe("¥1,234,567.89");
    expect(formatBusinessMoney("not-a-number")).toBe("not-a-number");
  });
});
