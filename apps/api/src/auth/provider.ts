export type DingTalkIdentity = Readonly<{ userId: string; unionId: string; corpId?: string }>;
export type OrganizationMember = Readonly<{
  corpId: string;
  userId: string;
  unionId: string;
  active: boolean;
  employed: boolean;
  displayName: string;
}>;
export type DirectoryOrganizationMember = OrganizationMember & Readonly<{
  departmentNames: readonly string[];
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
    url.search = new URLSearchParams({ redirect_uri: this.config.qrRedirectUri, response_type: "code", client_id: this.config.webClientId, scope: "openid", state, prompt: "consent" }).toString();
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
    const tokenCorpId = optionalText(token.corpId);
    positiveNumber(token.expireIn, "OAuth expireIn");
    if (tokenCorpId && tokenCorpId !== this.config.corpId) throw new DingTalkProtocolError("OAuth identity belongs to a different corporation");
    const profile = await this.json(`${API}/v1.0/contact/users/me`, { headers: { "x-acs-dingtalk-access-token": accessToken } });
    const identity: DingTalkIdentity = { userId: "", unionId: text(profile.unionId, "profile unionId") };
    return tokenCorpId ? { ...identity, corpId: tokenCorpId } : identity;
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
    if (!detail) return null;
    const result = record(detail.result, "user detail result");
    if (text(result.userid, "detail userid") !== userId) throw new DingTalkProtocolError("DingTalk user detail identity mismatch");
    const detailUnionId = optionalText(result.unionid);
    if (detailUnionId && detailUnionId !== identity.unionId) throw new DingTalkProtocolError("DingTalk union identity mismatch");
    const active = boolean(result.active, "active");
    return { corpId, userId, unionId: detailUnionId ?? identity.unionId, active, employed: true, displayName: optionalText(result.name) ?? "钉钉用户" };
  }

  async listOrganizationMembers(corpId: string): Promise<DirectoryOrganizationMember[]> {
    if (corpId !== this.config.corpId) {
      throw new DingTalkProtocolError("Directory request belongs to a different corporation");
    }
    const appToken = await this.getAppToken();
    const departments: Array<{ id: number; name: string }> = [{ id: 1, name: "全公司" }];
    const seenDepartments = new Set<number>([1]);

    for (let index = 0; index < departments.length; index += 1) {
      if (departments.length > 10_000) throw new DingTalkProtocolError("DingTalk department graph is unexpectedly large");
      const department = departments[index];
      if (!department) throw new DingTalkProtocolError("DingTalk department traversal failed");
      const body = await this.postOapi(
        "/topapi/v2/department/listsub",
        appToken,
        { dept_id: department.id, language: "zh_CN" },
      );
      if (!body) throw new DingTalkProtocolError("DingTalk department list was not found");
      const children = records(body.result, "department list");
      for (const child of children) {
        const id = integer(child.dept_id, "department dept_id");
        const name = text(child.name, "department name");
        if (seenDepartments.has(id)) {
          throw new DingTalkProtocolError("DingTalk department graph contains a duplicate or cycle");
        }
        seenDepartments.add(id);
        departments.push({ id, name });
      }
    }

    const rawMembers = new Map<string, { unionId: string; departmentNames: Set<string> }>();
    for (const department of departments) {
      let cursor = 0;
      const seenCursors = new Set<number>();
      for (let page = 0; page < 10_000; page += 1) {
        if (seenCursors.has(cursor)) throw new DingTalkProtocolError("DingTalk directory pagination repeated a cursor");
        seenCursors.add(cursor);
        const body = await this.postOapi(
          "/topapi/v2/user/list",
          appToken,
          { dept_id: department.id, cursor, size: 100, order_field: "custom", contain_access_limit: false, language: "zh_CN" },
        );
        if (!body) throw new DingTalkProtocolError("DingTalk member page was not found");
        const result = record(body.result, "member page result");
        const list = records(result.list, "member list");
        for (const value of list) {
          const userId = text(value.userid, "member userid");
          const unionId = text(value.unionid, "member unionid");
          const existing = rawMembers.get(userId);
          if (existing && existing.unionId !== unionId) {
            throw new DingTalkProtocolError("DingTalk directory returned conflicting stable identities");
          }
          const member = existing ?? { unionId, departmentNames: new Set<string>() };
          member.departmentNames.add(department.name);
          rawMembers.set(userId, member);
        }
        const hasMore = boolean(result.has_more, "member has_more");
        if (!hasMore) break;
        const nextCursor = integer(result.next_cursor, "member next_cursor");
        if (nextCursor <= cursor) throw new DingTalkProtocolError("DingTalk directory pagination did not advance");
        cursor = nextCursor;
        if (page === 9_999) throw new DingTalkProtocolError("DingTalk directory pagination exceeded the safe limit");
      }
    }

    const members: DirectoryOrganizationMember[] = [];
    for (const [userId, raw] of rawMembers) {
      const member = await this.getOrganizationMember({ userId, unionId: raw.unionId, corpId }, corpId);
      if (!member) throw new DingTalkProtocolError("DingTalk directory member could not be verified in the configured corporation");
      members.push({
        ...member,
        departmentNames: [...raw.departmentNames].sort((left, right) => left.localeCompare(right, "zh-CN")),
      });
    }
    return members.sort((left, right) => left.userId.localeCompare(right.userId));
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
function records(value: unknown, field: string): Record<string, unknown>[] { if (!Array.isArray(value)) throw new DingTalkProtocolError(`Invalid DingTalk ${field}`); return value.map((item, index) => record(item, `${field}[${index}]`)); }
function text(value: unknown, field: string): string { if (typeof value !== "string" || !value) throw new DingTalkProtocolError(`Invalid DingTalk ${field}`); return value; }
function optionalText(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function boolean(value: unknown, field: string): boolean { if (typeof value !== "boolean") throw new DingTalkProtocolError(`Invalid DingTalk ${field}`); return value; }
function integer(value: unknown, field: string): number { if (typeof value !== "number" || !Number.isInteger(value)) throw new DingTalkProtocolError(`Invalid DingTalk ${field}`); return value; }
function positiveNumber(value: unknown, field: string): number { if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new DingTalkProtocolError(`Invalid DingTalk ${field}`); return value; }
function assertOapiSuccess(value: Record<string, unknown>): void { const code = integer(value.errcode, "errcode"); if (code !== 0) throw new DingTalkProtocolError(`DingTalk API rejected request (${code})`); }
function isDirectoryMissing(code: number): boolean { return code === 60121 || code === 60111 || code === 400001; }
