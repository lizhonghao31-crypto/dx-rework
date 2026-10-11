import { formatBusinessMoney } from "@dx-rework/contracts/business-display";

export const fixedBusinessMoney = (value: string | number): string => {
  const money = formatBusinessMoney(value);
  if (!/^-?[\d,]+(?:\.\d+)?$/.test(money)) return money;
  const [whole, fraction = ""] = money.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
};

export const fixedBusinessCurrency = (value: string | number): string => `¥${fixedBusinessMoney(value)}`;
