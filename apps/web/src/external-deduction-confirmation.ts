import { formatBusinessCurrency } from "@dx-rework/contracts/business-display";

type Dialogs = {
  confirmInApp(message: string, options: {title: string; confirmLabel: string}): Promise<boolean>;
  promptInApp(message: string): Promise<string | null>;
  alertInApp(message: string): Promise<void>;
};
export type DeductionConfirmation = {kind: "normal"} | {kind: "special"; reason: string} | {kind: "cancelled"};
const money = (value: bigint) => `${value / 100n}.${(value % 100n).toString().padStart(2,"0")}`;

export async function confirmDeductionException(
  input: {amount: bigint; actual: bigint; proposed: bigint; forceSpecial: boolean},
  dialogs: Dialogs,
): Promise<DeductionConfirmation> {
  const nextActual=input.actual+input.amount;
  if (!input.forceSpecial) {
    if (nextActual<=input.proposed) return {kind:"normal"};
    await dialogs.alertInApp("累计扣款超出拟扣，请使用“转财务总监特批”。");
    return {kind:"cancelled"};
  }
  if (nextActual===input.proposed) {
    await dialogs.alertInApp("记录后累计实扣恰好等于拟扣金额，请点击“扣款”正常完成，无需特批。");
    return {kind:"cancelled"};
  }
  const over=nextActual>input.proposed;
  const difference=over?nextActual-input.proposed:input.proposed-nextActual;
  const reason=(await dialogs.promptInApp(
    `提交扣款特批申请：本次金额 ${formatBusinessCurrency(money(input.amount))}，批准后累计 ${formatBusinessCurrency(money(nextActual))}，拟扣 ${formatBusinessCurrency(money(input.proposed))}，${over?"超出拟扣":"未扣差额"} ${formatBusinessCurrency(money(difference))}。请填写特批原因。`,
  ))?.trim();
  if (!reason) return {kind:"cancelled"};
  if (reason.length>500) {
    await dialogs.alertInApp("特批原因最多 500 字。");
    return {kind:"cancelled"};
  }
  return {kind:"special",reason};
}

export const deductionInputState = (value: string, actual: string, proposed: string) => {
  const cents = (text: string): bigint | null => {
    if (!/^\d+(?:\.\d{1,2})?$/.test(text.trim())) return null;
    const [whole="0", fraction=""] = text.trim().split(".");
    return BigInt(whole)*100n+BigInt(fraction.padEnd(2,"0"));
  };
  const amount=cents(value), a=cents(actual), p=cents(proposed);
  const valid=amount!==null && amount>0n && a!==null && p!==null;
  const over=valid && a+amount>p;
  return {valid, over, ordinary: valid && !over, excess: over ? money(a+amount-p) : "0.00"};
};
