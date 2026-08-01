import { describe, expect, it, vi } from "vitest";

import { DingTalkProtocolError, OfficialDingTalkProvider, type DingTalkProviderConfig } from "../../apps/api/src/auth/provider.js";

const config: DingTalkProviderConfig = { corpId: "corp-a", h5AppKey: "h5-key", h5AppSecret: "h5-secret", webClientId: "web-client", webClientSecret: "web-secret", qrRedirectUri: "https://example.test/rework/auth/qr/callback" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function mockFetch(...responses: Response[]) { return vi.fn(async () => responses.shift() ?? json({}, 500)) as unknown as typeof fetch & ReturnType<typeof vi.fn>; }

describe("official DingTalk provider contracts", () => {
  it("uses app token, getuserinfo, and user detail for mobile login", async () => {
    const http = mockFetch(json({ errcode: 0, access_token: "app-token", expires_in: 7200 }), json({ errcode: 0, result: { userid: "user-1", unionid: "union-1" } }), json({ errcode: 0, result: { userid: "user-1", unionid: "union-1", name: "员工", active: true } }));
    const provider = new OfficialDingTalkProvider(config, http);
    const identity = await provider.exchangeMobileCode("mobile-code");
    expect(identity).toEqual({ userId: "user-1", unionId: "union-1", corpId: "corp-a" });
    expect(await provider.getOrganizationMember(identity, "corp-a")).toMatchObject({ userId: "user-1", active: true, employed: true });
    expect(http.mock.calls.map(([url]) => String(url))).toEqual([expect.stringContaining("/gettoken"), expect.stringContaining("/topapi/v2/user/getuserinfo"), expect.stringContaining("/topapi/v2/user/get")]);
    expect(String(http.mock.calls[0]?.[0])).toContain("appkey=h5-key");
  });

  it("uses OAuth, users/me, union mapping, and detail for browser scan", async () => {
    const http = mockFetch(json({ accessToken: "user-token", expireIn: 7200, corpId: "corp-a" }), json({ unionId: "union-1" }), json({ errcode: 0, access_token: "app-token", expires_in: 7200 }), json({ errcode: 0, result: { userid: "user-1", contact_type: 0 } }), json({ errcode: 0, result: { userid: "user-1", unionid: "union-1", name: "员工", active: true } }));
    const provider = new OfficialDingTalkProvider(config, http);
    const identity = await provider.exchangeQrCode("auth-code");
    expect(await provider.getOrganizationMember(identity, "corp-a")).toMatchObject({ userId: "user-1", unionId: "union-1", active: true });
    expect(http.mock.calls.map(([url]) => String(url))).toEqual([expect.stringContaining("/v1.0/oauth2/userAccessToken"), expect.stringContaining("/v1.0/contact/users/me"), expect.stringContaining("/gettoken"), expect.stringContaining("/topapi/user/getbyunionid"), expect.stringContaining("/topapi/v2/user/get")]);
    expect(JSON.parse(String(http.mock.calls[0]?.[1]?.body))).toMatchObject({ clientId: "web-client", clientSecret: "web-secret", code: "auth-code" });
  });

  it("requires openid/corpid scope and the configured web client", () => {
    const url = new URL(new OfficialDingTalkProvider(config, mockFetch()).buildQrAuthorizationUrl("state-1"));
    expect(url.searchParams.get("scope")).toBe("openid corpid");
    expect(url.searchParams.get("client_id")).toBe("web-client");
    expect(url.searchParams.get("state")).toBe("state-1");
  });

  it("shares concurrent app-token requests and refreshes near expiry", async () => {
    let now = 1_000;
    const http = mockFetch(json({ errcode: 0, access_token: "token-1", expires_in: 61 }), json({ errcode: 0, result: { userid: "u1", unionid: "x1" } }), json({ errcode: 0, result: { userid: "u2", unionid: "x2" } }), json({ errcode: 0, access_token: "token-2", expires_in: 7200 }), json({ errcode: 0, result: { userid: "u3", unionid: "x3" } }));
    const provider = new OfficialDingTalkProvider(config, http, () => now);
    await Promise.all([provider.exchangeMobileCode("one"), provider.exchangeMobileCode("two")]);
    expect(http.mock.calls.filter(([url]) => String(url).includes("/gettoken"))).toHaveLength(1);
    now += 1_001;
    await provider.exchangeMobileCode("three");
    expect(http.mock.calls.filter(([url]) => String(url).includes("/gettoken"))).toHaveLength(2);
  });

  it("fails closed for a different OAuth corpId, missing directory mapping, inactive member, and malformed responses", async () => {
    await expect(new OfficialDingTalkProvider(config, mockFetch(json({ accessToken: "token", expireIn: 7200, corpId: "corp-b" }))).exchangeQrCode("code")).rejects.toBeInstanceOf(DingTalkProtocolError);
    const missing = new OfficialDingTalkProvider(config, mockFetch(json({ errcode: 0, access_token: "app", expires_in: 7200 }), json({ errcode: 60121, errmsg: "not found" })));
    await expect(missing.getOrganizationMember({ userId: "", unionId: "outside", corpId: "corp-a" }, "corp-a")).resolves.toBeNull();
    const externalContact = new OfficialDingTalkProvider(config, mockFetch(json({ errcode: 0, access_token: "app", expires_in: 7200 }), json({ errcode: 0, result: { userid: "external", contact_type: 1 } })));
    await expect(externalContact.getOrganizationMember({ userId: "", unionId: "external", corpId: "corp-a" }, "corp-a")).resolves.toBeNull();
    const inactive = new OfficialDingTalkProvider(config, mockFetch(json({ errcode: 0, access_token: "app", expires_in: 7200 }), json({ errcode: 0, result: { userid: "u", unionid: "x", active: false } })));
    await expect(inactive.getOrganizationMember({ userId: "u", unionId: "x", corpId: "corp-a" }, "corp-a")).resolves.toMatchObject({ active: false });
    await expect(new OfficialDingTalkProvider(config, mockFetch(json({ errcode: "0" }))).exchangeMobileCode("code")).rejects.toBeInstanceOf(DingTalkProtocolError);
    const wrongUnion = new OfficialDingTalkProvider(config, mockFetch(json({ errcode: 0, access_token: "app", expires_in: 7200 }), json({ errcode: 0, result: { userid: "u", unionid: "other", active: true } })));
    await expect(wrongUnion.getOrganizationMember({ userId: "u", unionId: "expected", corpId: "corp-a" }, "corp-a")).rejects.toBeInstanceOf(DingTalkProtocolError);
  });
});
