import { describe, expect, it } from "vitest";

import { DisabledErpAdapter, IntegrationDisabledError } from "@dx-rework/domain";

describe("DisabledErpAdapter", () => {
  it("declares the future integration boundary without reading ERP", async () => {
    const adapter = new DisabledErpAdapter();
    await expect(adapter.status()).resolves.toEqual({ enabled: false, mode: "disabled" });
  });

  it("refuses writes while ERP integration is disabled", async () => {
    const adapter = new DisabledErpAdapter();
    await expect(adapter.publishResult({})).rejects.toBeInstanceOf(IntegrationDisabledError);
  });
});
