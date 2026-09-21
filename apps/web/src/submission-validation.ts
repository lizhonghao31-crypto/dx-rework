export type SubmissionIssue = Readonly<{ fieldId: string; message: string }>;

export class SubmissionRequestError extends Error {
  constructor(message: string, readonly code?: string, readonly status = 400) { super(message); }
}

export class SubmissionCancelled extends Error {}

export function submissionFailure(error: unknown): { title: string; message: string; uncertain: boolean; cancelled: boolean } {
  if (error instanceof SubmissionCancelled) return { title: "已取消", message: error.message, uncertain: false, cancelled: true };
  if (error instanceof SubmissionRequestError && (error.code === "IDEMPOTENCY_IN_PROGRESS" || error.code === "IDEMPOTENCY_CONFLICT")) {
    return { title: "提交结果待确认", message: "原请求仍在处理中或请求标识存在冲突，请核对原提交结果。", uncertain: true, cancelled: false };
  }
  if (error instanceof SubmissionRequestError && error.status >= 400 && error.status < 500 && error.status !== 408) {
    return {
      title: error.status === 401 ? "登录已失效" : error.status === 403 ? "无权执行此操作" : error.status === 409 ? "资料或状态已变化" : "未能提交",
      message: error.message, uncertain: false, cancelled: false,
    };
  }
  return { title: "提交结果待确认", message: "未收到可确认的提交结果。", uncertain: true, cancelled: false };
}
