export type DingTalkIdentity = Readonly<{ userId: string; unionId: string; corpId?: string }>;
export type OrganizationMember = Readonly<{
  corpId: string;
  userId: string;
  unionId: string;
  active: boolean;
  employed: boolean;
  displayName: string;
}>;

export interface DingTalkProvider {
  exchangeMobileCode(code: string): Promise<DingTalkIdentity>;
  exchangeQrCode(code: string): Promise<DingTalkIdentity>;
  getOrganizationMember(identity: DingTalkIdentity, corpId: string): Promise<OrganizationMember | null>;
  buildQrAuthorizationUrl(state: string): string;
}

export type DingTalkProviderConfig = Readonly<{
  corpId: string;
  h5AppKey: string;
  h5AppSecret: string;
  webClientId: string;
  webClientSecret: string;
  qrRedirectUri: string;
}>;

type Fetch = typeof fetch;
const API = "https://api.dingtalk.com";
const OAPI = "https://oapi.dingtalk.com";

export class DingTalkProtocolError extends Error {
  constructor(message: string) { super(message); this.name = "DingTalkProtocolError"; }
}

/** Official DingTalk dual-entry adapter. It fails closed and never returns raw responses. */
export class OfficialDingTalkProvider implements DingTalkProvider {
  private cachedAppToken?: { token: string; refreshAt: number };
  private appTokenRequest: Promise<string> | undefined;
  constructor(private readonly config: DingTalkProviderConfig, private readonly http: Fetch = fetch, private readonly now: () => number = Date.now) {}

  buildQrAuthorizationUrl(state: string): string {
    const url = new URL("https://login.dingtalk.com/oauth2/auth");
    url.search = new URLSearchParams({ redirect_uri: this.config.qrRedirectUri, response_type: "code", client_id: this.config.webClientId, scope: "openid corpid", state, prompt: "consent" }).toString();
    return url.toString();
  }

  async exchangeMobileCode(code: string): Promise<DingTalkIdentity> {
    const appToken = await this.getAppToken();
    const body = await this.postOapi("/topapi/v2/user/getuserinfo", appToken, { code });
    if (!body) throw new DingTalkProtocolError("DingTalk mobile identity was not found");
    const result = record(body.result, "mobile user result");
    return { userId: text(result.userid, "userid"), unionId: text(result.unionid, "unionid"), corpId: this.config.corpId };
  }

  async exchangeQrCode(code: string): Promise<DingTalkIdentity> {
    const token = await this.json(`${API}/v1.0/oauth2/userAccessToken`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ clientId: this.config.webClientId, clientSecret: this.config.webClientSecret, code, grantType: "authorization_code" }) });
    const accessToken = text(token.accessToken, "OAuth accessToken");
    const tokenCorpId = text(token.corpId, "OAuth corpId");
    positiveNumber(token.expireIn, "OAuth expireIn");
    if (tokenCorpId !== this.config.corpId) throw new DingTalkProtocolError("OAuth identity belongs to a different corporation");
    const profile = await this.json(`${API}/v1.0/contact/users/me`, { headers: { "x-acs-dingtalk-access-token": accessToken } });
    return { userId: "", unionId: text(profile.unionId, "profile unionId"), corpId: tokenCorpId };
  }

  async getOrganizationMember(identity: DingTalkIdentity, corpId: string): Promise<OrganizationMember | null> {
    if (corpId !== this.config.corpId || (identity.corpId && identity.corpId !== corpId)) return null;
    const appToken = await this.getAppToken();
    let userId = identity.userId;
    if (!userId) {
      const mapping = await this.postOapi("/topapi/user/getbyunionid", appToken, { unionid: identity.unionId }, true);
      if (!mapping) return null;
      const result = record(mapping.result, "union mapping result");
      if (result.contact_type !== undefined && integer(result.contact_type, "contact_type") !== 0) return null;
      userId = optionalText(result.userid) ?? "";
      if (!userId) return null;
    }
    const detail = await this.postOapi("/topapi/v2/user/get", appToken, { userid: userId }, true);
    if (!detail) return { corpId, userId, unionId: identity.unionId, active: false, employed: false, displayName: "钉钉用户" };
    const result = record(detail.result, "user detail result");
    if (text(result.userid, "detail userid") !== userId) throw new DingTalkProtocolError("DingTalk user detail identity mismatch");
    const detailUnionId = optionalText(result.unionid);
    if (detailUnionId && detailUnionId !== identity.unionId) throw new DingTalkProtocolError("DingTalk union identity mismatch");
    const active = boolean(result.active, "active");
    return { corpId, userId, unionId: detailUnionId ?? identity.unionId, active, employed: true, displayName: optionalText(result.name) ?? "钉钉用户" };
  }

  private async getAppToken(): Promise<string> {
    if (this.cachedAppToken && this.cachedAppToken.refreshAt > this.now()) return this.cachedAppToken.token;
    if (this.appTokenRequest) return this.appTokenRequest;
    this.appTokenRequest = this.fetchAppToken();
    try { return await this.appTokenRequest; } finally { this.appTokenRequest = undefined; }
  }

  private async fetchAppToken(): Promise<string> {
    const url = new URL(`${OAPI}/gettoken`); url.search = new URLSearchParams({ appkey: this.config.h5AppKey, appsecret: this.config.h5AppSecret }).toString();
    const body = await this.json(url.toString());
    assertOapiSuccess(body);
    const expiresIn = positiveNumber(body.expires_in, "app token expires_in");
    const token = text(body.access_token, "app access_token");
    this.cachedAppToken = { token, refreshAt: this.now() + Math.max(1, expiresIn - 60) * 1_000 };
    return token;
  }

  private async postOapi(path: string, token: string, payload: object, missingIsNull = false): Promise<Record<string, unknown> | null> {
    const url = new URL(`${OAPI}${path}`); url.searchParams.set("access_token", token);
    const body = await this.json(url.toString(), { method: "POST", headers: jsonHeaders(), body: JSON.stringify(payload) });
    const errcode = integer(body.errcode, "errcode");
    if (missingIsNull && isDirectoryMissing(errcode)) return null;
    assertOapiSuccess(body);
    return body;
  }

  private async json(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const signal = AbortSignal.timeout(5_000);
    let response: Response;
    try { response = await this.http(url, { ...init, signal }); } catch { throw new DingTalkProtocolError("DingTalk request failed or timed out"); }
    if (!response.ok) throw new DingTalkProtocolError(`DingTalk HTTP status ${response.status}`);
    let value: unknown;
    try { value = await response.json(); } catch { throw new DingTalkProtocolError("DingTalk returned invalid JSON"); }
    return record(value, "response");
  }
}

function jsonHeaders(): Record<string, string> { return { "content-type": "application/json" }; }
function record(value: unknown, field: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DingTalkProtocolError(`Invalid DingTalk ${field}`); return value as Record<string, unknown>; }
function text(value: unknown, field: string): string { if (typeof value !== "string" || !value) throw new DingTalkProtocolError(`Invalid DingTalk ${field}`); return value; }
function optionalText(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function boolean(value: unknown, field: string): boolean { if (typeof value !== "boolean") throw new DingTalkProtocolError(`Invalid DingTalk ${field}`); return value; }
function integer(value: unknown, field: string): number { if (typeof value !== "number" || !Number.isInteger(value)) throw new DingTalkProtocolError(`Invalid DingTalk ${field}`); return value; }
function positiveNumber(value: unknown, field: string): number { if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new DingTalkProtocolError(`Invalid DingTalk ${field}`); return value; }
function assertOapiSuccess(value: Record<string, unknown>): void { const code = integer(value.errcode, "errcode"); if (code !== 0) throw new DingTalkProtocolError(`DingTalk API rejected request (${code})`); }
function isDirectoryMissing(code: number): boolean { return code === 60121 || code === 60111 || code === 400001; }
