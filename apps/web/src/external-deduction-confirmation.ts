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
  if (nextActual<=input.proposed && !input.forceSpecial) return {kind:"normal"};
  if (nextActual===input.proposed) {
    await dialogs.alertInApp("记录后累计实扣恰好等于拟扣金额，请点击“扣款”正常完成，无需特批。");
    return {kind:"cancelled"};
  }
  const over=nextActual>input.proposed;
  const difference=over?nextActual-input.proposed:input.proposed-nextActual;
  const confirmed=await dialogs.confirmInApp(
    `本次将记录实际已扣 ${formatBusinessCurrency(money(input.amount))}，累计实扣 ${formatBusinessCurrency(money(nextActual))}，拟扣 ${formatBusinessCurrency(money(input.proposed))}，${over?"超扣":"未扣差额"} ${formatBusinessCurrency(money(difference))}。确认这些款项已经实际扣除，并同时提交财务总监特批？`,
    {title:"记录实扣并提交特批",confirmLabel:"确认已实扣，继续"},
  );
  if (!confirmed) return {kind:"cancelled"};
  const reason=(await dialogs.promptInApp(over?"请填写超额扣款原因":"请填写部分扣款原因"))?.trim();
  if (!reason) return {kind:"cancelled"};
  if (reason.length>500) {
    await dialogs.alertInApp("特批原因最多 500 字。");
    return {kind:"cancelled"};
  }
  return {kind:"special",reason};
}
