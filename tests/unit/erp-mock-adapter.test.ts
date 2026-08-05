import { MockErpAdapter } from "@dx-rework/domain";
import { describe, expect, it } from "vitest";

describe("MockErpAdapter", () => {
  it("records contract traffic without connecting to ERP", async () => {
    const adapter = new MockErpAdapter();
    const source = { contractVersion: "1", externalId: "ERP-1" };
    const result = { contractVersion: "1", status: "completed" };

    await expect(adapter.status()).resolves.toEqual({ enabled: true, mode: "mock" });
    await adapter.acceptSourceRecord(source);
    await adapter.publishResult(result);

    expect(adapter.acceptedSourceRecords).toEqual([source]);
    expect(adapter.publishedResults).toEqual([result]);
  });
});
