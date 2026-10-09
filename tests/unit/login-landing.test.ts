import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

  it("keeps the filing numbers and adds the official local badge and query link", () => {
    const html = renderToStaticMarkup(createElement(LoginLanding, {
      message: "TEST SDK 状态",
      qr: null,
      action: null,
    }));
    expect(html).toContain('href="https://beian.miit.gov.cn/"');
    expect(html).toContain('href="https://beian.mps.gov.cn/#/query/webSearch?code=44011102484833"');
    expect(html).toMatch(/<a class="dx-login-public-security"[^>]*target="_blank"[^>]*rel="noopener noreferrer">/);
    expect(html).toMatch(/<img[^>]*src="[^"]*public-security-filing\.png"[^>]*alt=""[^>]*aria-hidden="true"/);
    const badge = readFileSync(new URL("../../apps/web/src/assets/public-security-filing.png", import.meta.url));
    expect(createHash("sha256").update(badge).digest("hex")).toBe("6189a29f86e1756d1970f4446b9f836642c283c373d312dbddeb42411f1608e6");
  });

  it("reduces all left-side responsive font sizes by 3px and filing sizes by 4px", () => {
    const css = readFileSync(new URL("../../apps/web/src/login-landing.css", import.meta.url), "utf8");
    const fontSizes = (selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((match) => match[1]?.trim() === selector)
      .flatMap((match) => [...(match[2] ?? "").matchAll(/font-size:\s*([^;]+);/g)].map((size) => size[1]?.trim()));
    expect(fontSizes(".dx-login-brand strong")).toEqual(["33px", "27px"]);
    expect(fontSizes(".dx-login-brand small")).toEqual(["6px"]);
    expect(fontSizes(".dx-login-hero h1")).toEqual([
      "clamp(39px, calc(4.55vw - 3px), 73px)",
      "calc(4.55vw - 3px)",
      "clamp(27px, calc(7vw - 3px), 49px)",
    ]);
    expect(fontSizes(".dx-login-subtitle")).toEqual(["clamp(18px, calc(1.8vw - 3px), 27px)", "18px", "16px", "14px"]);
    expect(fontSizes(".dx-login-features strong")).toEqual(["15px", "12px", "11px"]);
    expect(fontSizes(".dx-login-features small")).toEqual(["10px", "8px"]);
    expect(fontSizes(".dx-login-filing")).toEqual(["11px", "8px"]);
    expect(css).toContain(".dx-login-public-security img { width: 16px; height: auto; flex: none; }");
    // The right-side live QR, instructions, action and status keep their prior sizes.
    expect(fontSizes(".dx-login-qr-card h2")).toEqual(["32px", "28px", "26px"]);
    expect(fontSizes(".dx-login-instruction")).toEqual(["18px", "16px", "14px"]);
    expect(fontSizes(".dx-login-action .dx-button")).toEqual(["18px"]);
    expect(fontSizes(".dx-login-status")).toEqual(["13px"]);
  });
});

