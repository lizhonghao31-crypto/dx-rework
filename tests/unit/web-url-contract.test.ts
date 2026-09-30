import { describe, expect, it } from "vitest";

import {
  createWebUrls,
  normalizeBasePath,
  resolveWebApiPath,
  rewriteApiProxyPath,
} from "../../apps/web/url-contract.js";

const reworkOrderId = "123e4567-e89b-42d3-a456-426614174000";

describe("web base-path and API proxy contract", () => {
  it.each([
    [undefined, "/auth/login", "/api/auth/me", "/api", "/auth/me"],
    [
      "/rework/",
      "/rework/auth/login",
      "/rework/api/auth/me",
      "/rework/api",
      "/auth/me",
    ],
  ] as const)(
    "separates page and API URLs for base %s",
    (base, page, api, prefix, rewritten) => {
      const urls = createWebUrls(base);
      expect(urls.pageUrl("auth/login")).toBe(page);
      expect(urls.apiUrl("auth/me", null)).toBe(api);
      expect(urls.apiProxyPrefix).toBe(prefix);
      expect(rewriteApiProxyPath(`${prefix}/auth/me`, prefix)).toBe(rewritten);
    },
  );

  it("uses order-scoped supplier options on a real task detail page", () => {
    const location = {
      pathname: `/rework/ui/tasks/${reworkOrderId}`,
      search: "",
    };
    expect(
      createWebUrls("/rework/").apiUrl("master-data/suppliers", location),
    ).toBe(
      `/rework/api/rework-orders/${reworkOrderId}/external-responsibilities/supplier-options`,
    );
    expect(
      resolveWebApiPath("master-data/suppliers", "/rework/", location),
    ).toBe(
      `rework-orders/${reworkOrderId}/external-responsibilities/supplier-options`,
    );
  });

  it("keeps the global supplier catalog outside an order detail", () => {
    expect(
      createWebUrls("/rework/").apiUrl("master-data/suppliers", {
        pathname: "/rework/system/foundation",
        search: "",
      }),
    ).toBe("/rework/api/master-data/suppliers");
  });

  it.each([
    "//example.com",
    "/rework//admin",
    "/rework?next=/",
    "/rework#x",
    "https://example.com",
  ])("rejects unsafe base path %s", (value) => {
    expect(() => normalizeBasePath(value)).toThrow();
  });
});
