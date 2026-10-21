import { describe, expect, it } from "vitest";
import { ApplicationError } from "../../apps/api/src/platform/errors.js";
import { hasInvalidDeclaredImageError } from "../../apps/web/src/attachment-upload.js";
import { publicErrorMessage } from "../../apps/api/src/platform/public-error-message.js";
describe("HTTP public error language", () => {
  it("keeps domain errors unchanged and translates at the response boundary without losing cause", () => {
    const error = new ApplicationError("ATTACHMENT_NOT_READY", "Attachment is not ready", 409);
    expect(publicErrorMessage(error)).toBe("附件尚未完成校验，请稍后重试");
    expect(error.message).toBe("Attachment is not ready");
    expect(error.code).toBe("ATTACHMENT_NOT_READY"); expect(error.statusCode).toBe(409);
    expect(publicErrorMessage(new ApplicationError("VALIDATION_ERROR", "PO 2 客户交期不能早于本月", 400))).toBe("PO 2 客户交期不能早于本月");
  });
  it("has a Chinese recovery hint and retains error codes for unknown internal messages", () => {
    expect(publicErrorMessage({ code: "AUTH_BUSY", message: "Busy" })).not.toContain("AUTH_BUSY");
    expect(publicErrorMessage({code:"SQL_PRIVATE_ID",message:"SELECT secret FROM private_data"})).not.toMatch(/SQL_PRIVATE_ID|SELECT|private_data/);
    expect(publicErrorMessage({code:"SQL_PRIVATE_ID",message:"SELECT secret FROM private_data"})).toContain("尚未确认");
    expect(publicErrorMessage({ code: "VALIDATION_ERROR", message: "Invalid input" })).not.toContain("Invalid input");
    const imageError = { code: "VALIDATION_ERROR", message: "Uploaded object is not a valid file of the declared type" };
    expect(publicErrorMessage(imageError)).toBe("附件内容与申报文件类型不一致，请重新选择有效原文件");
    expect(hasInvalidDeclaredImageError(new Error(publicErrorMessage(imageError)))).toBe(true);
  });
});
