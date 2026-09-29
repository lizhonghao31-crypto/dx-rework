import type { DigitalCustomer, DigitalOrderInput } from "@dx-rework/contracts/digital-production";
export function initialDigitalProductGroup(customers: DigitalCustomer[], customerCode: string | null | undefined): DigitalOrderInput["productGroup"] {
  return (customers.find(customer => customer.code === customerCode)?.productGroups[0] ?? "男装") as DigitalOrderInput["productGroup"];
}
