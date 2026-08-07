import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("达兴统一钉钉登录入口", () => {
  it("reuses the ERP embedded QR SDK instead of top-level OAuth navigation", async () => {
    const auth = await readFile("apps/web/src/auth.tsx", "utf8");
    expect(auth).toContain("h5-dingtalk-login/0.21.0/ddlogin.js");
    expect(auth).toContain("DTFrameLogin");
    expect(auth).toContain('apiUrl("auth/qr/complete")');
    expect(auth).toContain("QrRelayPage");
    expect(auth).not.toContain("window.location.assign(body.authorizationUrl)");
  });

  it("serializes QR challenge creation and disables regeneration while pending", async () => {
    const auth = await readFile("apps/web/src/auth.tsx", "utf8");
    expect(auth).toContain("const challengeBusy = useRef(true);");
    expect(auth).toContain("const challengeQueue = useRef<Promise<void>>(Promise.resolve());");
    expect(auth).toContain("const previousStart = challengeQueue.current;");
    expect(auth).toContain("await previousStart;");
    expect(auth).toContain("if (challengeBusy.current) return;");
    expect(auth).toContain("<Button disabled={starting} onClick={regenerate}>重新生成二维码</Button>");
    expect(auth).not.toContain("<Button onClick={() => setAttempt((value) => value + 1)}>重新生成二维码</Button>");
  });

  it("routes the same-origin relay before protected business pages", async () => {
    const app = await readFile("apps/web/src/App.tsx", "utf8");
    const relay = app.indexOf('path === "/auth/qr/relay"');
    const business = app.indexOf('path === "/ui/admin"');
    expect(relay).toBeGreaterThan(-1);
    expect(relay).toBeLessThan(business);
  });

  it("keeps OAuth codes out of Nginx access and error logs", async () => {
    const nginx = await readFile("infra/nginx/dx-rework.conf.example", "utf8");
    const start = nginx.indexOf("location = /rework/auth/qr/relay {");
    const end = nginx.indexOf("\n    }", start);
    const block = nginx.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain("access_log off;");
    expect(block).toContain("error_log /dev/null emerg;");
    expect(block).toContain("try_files /index.html =404;");
  });

  it("documents the relay URI as the production redirect contract", async () => {
    const env = await readFile(".env.example", "utf8");
    expect(env).toContain("DINGTALK_QR_REDIRECT_URI=https://replace.example/rework/auth/qr/relay");
    expect(env).not.toContain("DINGTALK_QR_REDIRECT_URI=https://replace.example/api/auth/qr/callback");
  });
});
