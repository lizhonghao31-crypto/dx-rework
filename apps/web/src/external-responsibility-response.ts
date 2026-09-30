/** Keep contract diagnostics out of the business page without weakening validation. */
export async function readExternalResponsibilityResponse<T>(
  response: Response,
  schema: { parse: (value: unknown) => T },
  operation: "read" | "write",
): Promise<T> {
  try {
    return schema.parse(await response.json());
  } catch (error: unknown) {
    const requestId = response.headers.get("x-request-id");
    console.error("external-responsibility-response", { operation, requestId, error });
    const message = operation === "read"
      ? "扣款资料加载失败，请刷新重试。"
      : "提交已获服务器响应，但结果暂未能显示。请先刷新核对台账，勿重复录入。";
    throw new Error(`${message}${requestId ? `（请求编号：${requestId}）` : ""}`);
  }
}
