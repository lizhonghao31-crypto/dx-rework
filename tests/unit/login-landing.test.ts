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
    for (const text of ["达兴", "钉钉扫码登录", "粤ICP备2026043374号-1", "粤公网安备44011102484833号"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('id="dx-rework-dingtalk-qr"');
    expect(html).toMatch(/<div class="dx-login-qr-frame"><div class="dx-login-qr-content"><div id="dx-rework-dingtalk-qr"/);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("TEST SDK 状态");
    expect(html).toContain("disabled");
    for (const text of ["达兴数字生产助手", "企业数字化生产协同入口", "订单协同", "生产管理", "供应链协同", "精益运营", "DA XING APPAREL", "dx-login-hero", "DXERP", "达兴组织准入", "让好设计", "用数字化", "DA XING DIGITAL PRODUCTION ASSISTANT"]) {
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

  it("centers a compact card, reduces its own text by 3px and preserves the filing styles", () => {
    const css = readFileSync(new URL("../../apps/web/src/login-landing.css", import.meta.url), "utf8");
    const fontSizes = (selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((match) => match[1]?.trim() === selector)
      .flatMap((match) => [...(match[2] ?? "").matchAll(/font-size:\s*([^;]+);/g)].map((size) => size[1]?.trim()));
    expect(fontSizes(".dx-login-brand strong")).toEqual(["33px", "27px"]);
    expect(fontSizes(".dx-login-brand small")).toEqual([]);
    expect(css).not.toContain("dx-login-hero");
    expect(css).not.toContain("dx-login-features");
    expect(fontSizes(".dx-login-filing")).toEqual(["11px", "8px"]);
    expect(css).toContain(".dx-login-public-security img { width: 16px; height: auto; flex: none; }");
    // Each responsive text value is exactly 3px smaller than the prior card.
    expect(css).toContain("display: grid;\n  place-items: center;");
    expect(css).toContain("min-height: 100svh;");
    expect(css).toContain("padding: 104px 24px;");
    expect(css).toContain("max-width: 442px; grid-template-columns: minmax(0, 1fr);");
    expect(css).toContain(".dx-login-qr-frame { width: 255px; height: 255px;");
    expect(css).toContain(".dx-login-qr-content { width: 300px; height: 300px; transform: scale(.85); transform-origin: top left; }");
    expect(css).toContain(".dx-login-qr-content > div { width: 300px; min-height: 300px; }");
    expect(css).not.toContain("overflow: auto");
    expect(css).not.toContain("position: fixed");
    expect(fontSizes(".dx-login-qr-card h2")).toEqual(["29px", "25px", "23px"]);
    expect(fontSizes(".dx-login-instruction")).toEqual(["15px", "13px", "11px"]);
    expect(fontSizes(".dx-login-action .dx-button")).toEqual(["15px"]);
    expect(fontSizes(".dx-login-status")).toEqual(["10px"]);
    expect(fontSizes(".dx-login-status > span:first-child")).toEqual(["14px"]);
  });
});

