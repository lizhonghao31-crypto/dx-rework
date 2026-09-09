const SUPPLIER_CONTACT_ROLES = new Set([
  "owner_group",
  "order_merchandiser",
  "production_management",
]);

const SUPPLIER_CONTRACT_ROLES = new Set([
  "owner_group",
  "order_merchandiser",
  "production_management",
  "factory_payables",
  "embroidery_washing_payables",
  "fabric_payables",
  "finance_director",
]);

const SUPPLIER_PAYMENT_ROLES = new Set([
  "owner_group",
  "order_merchandiser",
  "production_management",
  "factory_payables",
  "embroidery_washing_payables",
  "fabric_payables",
  "finance_director",
]);

const DAXING_PRICE_ROLES = new Set([
  "owner_group",
  "order_merchandiser",
  "ie_reviewer",
  "production_management",
]);

const SUPPLIER_CONTACT_FIELDS = new Set(["contactPerson", "contactPhone", "address"]);
const SUPPLIER_CONTRACT_FIELDS = new Set(["contractEntityName", "partyBRepresentative"]);
const SUPPLIER_PAYMENT_FIELDS = new Set(["payeeName", "bankAccount", "bankName"]);
const DAXING_PRICE_FIELDS = new Set(["daxingUnitPrice", "approvalDaxingUnitPrice"]);

export function canReadSupplierContactData(roles: readonly string[], isRoot: boolean): boolean {
  return isRoot || roles.some((role) => SUPPLIER_CONTACT_ROLES.has(role));
}

export function canReadSupplierContractData(roles: readonly string[], isRoot: boolean): boolean {
  return isRoot || roles.some((role) => SUPPLIER_CONTRACT_ROLES.has(role));
}

export function canReadSupplierPaymentData(roles: readonly string[], isRoot: boolean): boolean {
  return isRoot || roles.some((role) => SUPPLIER_PAYMENT_ROLES.has(role));
}

export function canReadDaxingPrice(roles: readonly string[], isRoot: boolean): boolean {
  return isRoot || roles.some((role) => DAXING_PRICE_ROLES.has(role));
}

function redactObject(
  value: unknown,
  options: Readonly<{
    supplier: boolean;
    daxingPrice: boolean;
    contactAllowed: boolean;
    contractAllowed: boolean;
    paymentAllowed: boolean;
    daxingPriceAllowed: boolean;
  }>,
): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactObject(entry, options));
  if (value === null || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (options.supplier && !options.contactAllowed && SUPPLIER_CONTACT_FIELDS.has(key)) continue;
    if (options.supplier && !options.contractAllowed && SUPPLIER_CONTRACT_FIELDS.has(key)) continue;
    if (options.supplier && !options.paymentAllowed && SUPPLIER_PAYMENT_FIELDS.has(key)) continue;
    if (options.daxingPrice && !options.daxingPriceAllowed && DAXING_PRICE_FIELDS.has(key)) continue;

    if (options.supplier && key === "contractDataMissing" && Array.isArray(raw)) {
      output[key] = raw.filter((entry) => {
        if (typeof entry !== "string") return false;
        if (!options.contactAllowed && entry === "address") return false;
        if (!options.contractAllowed && ["contractEntityName", "partyBRepresentative"].includes(entry)) return false;
        if (!options.paymentAllowed && ["payeeName", "bankAccount", "bankName"].includes(entry)) return false;
        return true;
      });
      continue;
    }

    output[key] = redactObject(raw, options);
  }
  return output;
}

export function redactPermissionSensitivePayload(
  path: string,
  payload: unknown,
  roles: readonly string[],
  isRoot: boolean,
): unknown {
  const supplier = path === "/master-data/suppliers" || path.startsWith("/master-data/suppliers/");
  const daxingPrice = path === "/sourcing" || path.startsWith("/sourcing/");
  if (!supplier && !daxingPrice) return payload;

  return redactObject(payload, {
    supplier,
    daxingPrice,
    contactAllowed: canReadSupplierContactData(roles, isRoot),
    contractAllowed: canReadSupplierContractData(roles, isRoot),
    paymentAllowed: canReadSupplierPaymentData(roles, isRoot),
    daxingPriceAllowed: canReadDaxingPrice(roles, isRoot),
  });
}
