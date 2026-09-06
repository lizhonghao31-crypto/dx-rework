// Normalize user-entered decimal text without floating point or rounding.
export function normalizeSampleMoneyFields(fields: Record<string, unknown>): Record<string, unknown> {
  const result = { ...fields };
  for (const field of ["amount", "finalAmount", "purchasePrice"] as const) {
    const value = result[field];
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (!/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(text)) {
      throw new Error("金额必须为非负数字，最多两位小数");
    }
    const [whole, fraction = ""] = text.split(".");
    result[field] = `${whole}.${fraction.padEnd(2, "0")}`;
  }
  return result;
}
