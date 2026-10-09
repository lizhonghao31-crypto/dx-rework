import type { ReactNode } from "react";
import "./login-landing.css";
import publicSecurityFilingBadge from "./assets/public-security-filing.png";

export function LoginLanding({ message, qr, action }: {
  message: string;
  qr: ReactNode;
  action: ReactNode;
}) {
  return (
    <main className="dx-login-landing">
      <header className="dx-login-brand" aria-label="DX 达兴服装">
        <svg viewBox="0 0 92 45" aria-hidden="true">
          <path fill="#f4f7ff" fillRule="evenodd" d="M10 5h21c18 0 21 10 16 25-3 8-10 12-21 12H1L10 5Zm9 8-5 21h13c6 0 10-4 12-10 2-8-1-11-9-11H19Z" />
          <path fill="#77b9fb" d="m43 5 15 17-19 20h15l11-12 10 12h15L72 21 88 2H72L62 14 54 5Z" />
        </svg>
        <span><strong>达兴</strong></span>
      </header>
      <div className="dx-login-layout">
        <section className="dx-login-qr-card" aria-labelledby="dx-login-qr-title">
          <h2 id="dx-login-qr-title">钉钉扫码登录</h2>
          <p className="dx-login-instruction">请使用手机钉钉扫描二维码，并在钉钉中确认登录</p>
          <div className="dx-login-qr-frame"><div className="dx-login-qr-content">{qr}</div></div>
          <div className="dx-login-action">{action}</div>
          <p className="dx-login-status" role="status" aria-live="polite">
            <span aria-hidden="true">ⓘ</span><span>{message}</span>
          </p>
        </section>
      </div>
      <footer className="dx-login-filing">
        <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">粤ICP备2026043374号-1</a>
        <span className="dx-login-filing-divider" aria-hidden="true">|</span>
        <a className="dx-login-public-security" href="https://beian.mps.gov.cn/#/query/webSearch?code=44011102484833" target="_blank" rel="noopener noreferrer">
          <img src={publicSecurityFilingBadge} alt="" aria-hidden="true" />
          <span>粤公网安备44011102484833号</span>
        </a>
      </footer>
    </main>
  );
}

