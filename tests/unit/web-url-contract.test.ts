import { describe, expect, it } from "vitest";

import { createWebUrls, normalizeBasePath, rewriteApiProxyPath } from "../../apps/web/url-contract.js";

describe("web base-path and API proxy contract", () => {
  it.each([
    [undefined, "/auth/login", "/api/auth/me", "/api", "/auth/me"],
    ["/rework/", "/rework/auth/login", "/rework/api/auth/me", "/rework/api", "/auth/me"],
  ] as const)("separates page and API URLs for base %s", (base, page, api, prefix, rewritten) => {
    const urls = createWebUrls(base);
    expect(urls.pageUrl("auth/login")).toBe(page);
    expect(urls.apiUrl("auth/me")).toBe(api);
    expect(urls.apiProxyPrefix).toBe(prefix);
    expect(rewriteApiProxyPath(`${prefix}/auth/me`, prefix)).toBe(rewritten);
  });

  it.each(["//example.com", "/rework//admin", "/rework?next=/", "/rework#x", "https://example.com"])("rejects unsafe base path %s", (value) => {
    expect(() => normalizeBasePath(value)).toThrow();
  });
});
