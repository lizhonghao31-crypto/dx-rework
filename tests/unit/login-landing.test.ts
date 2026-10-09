import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoginLanding } from "../../apps/web/src/login-landing.js";

describe("PC 登录定稿视图", () => {
  it("renders the approved text and live QR/action slots as accessible DOM", () => {
    const html = renderToStaticMarkup(createElement(LoginLanding, {
      message: "TEST SDK 状态",
      qr: createElement("div", { id: "dx-rework-dingtalk-qr", "aria-label": "钉钉登录二维码" }),
      action: createElement("button", { disabled: true }, "重新生成二维码"),
    }));
    for (const text of ["达兴数字生产助手", "企业数字化生产协同入口", "订单协同", "生产管理", "供应链协同", "精益运营", "钉钉扫码登录", "粤ICP备2026043374号-1", "粤公网安备44011102484833号"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('id="dx-rework-dingtalk-qr"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("TEST SDK 状态");
    expect(html).toContain("disabled");
    for (const text of ["DXERP", "达兴组织准入", "让好设计", "用数字化", "DA XING DIGITAL PRODUCTION ASSISTANT"]) {
      expect(html).not.toContain(text);
    }
    expect(html).not.toContain("data:image");
  });
});
