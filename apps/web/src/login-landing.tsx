import type { ReactNode } from "react";
import "./login-landing.css";

const features = [
  { title: "订单协同", detail: "全流程可视", icon: <><path d="M12 5h22l5 6v29H12a5 5 0 0 1-5-5V10a5 5 0 0 1 5-5Z" /><path d="M34 5v7h6M15 16h16M15 23h16M15 30h10" /></> },
  { title: "生产管理", detail: "数据驱动", icon: <><path d="M5 40V23h10V5h9v23l10-9v9l9-6v18H5Z" /><path d="M15 23v8" /></> },
  { title: "供应链协同", detail: "数据驱动", icon: <><circle cx="24" cy="15" r="8" /><path d="M11 41v-6a13 13 0 0 1 26 0v6M8 40v-5a12 12 0 0 1 5-10M40 40v-5a12 12 0 0 0-5-10M9 8a8 8 0 0 0 0 15M39 8a8 8 0 0 1 0 15" /></> },
  { title: "精益运营", detail: "持续提升", icon: <><path d="M6 40V27h10v13M19 40V17h10v23M32 40V6h10v34M4 40h40" /></> },
];

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
        <span><strong>达兴</strong><small>DA XING APPAREL</small></span>
      </header>
      <div className="dx-login-layout">
        <section className="dx-login-hero" aria-label="达兴数字生产助手">
          <h1>达兴数字生产助手</h1>
          <p className="dx-login-subtitle">企业数字化生产协同入口</p>
          <div className="dx-login-divider" aria-hidden="true" />
          <ul className="dx-login-features">
            {features.map((feature) => <li key={feature.title}>
              <svg viewBox="0 0 48 48" aria-hidden="true">{feature.icon}</svg>
              <strong>{feature.title}</strong><small>{feature.detail}</small>
            </li>)}
          </ul>
        </section>
        <section className="dx-login-qr-card" aria-labelledby="dx-login-qr-title">
          <h2 id="dx-login-qr-title">钉钉扫码登录</h2>
          <p className="dx-login-instruction">请使用手机钉钉扫描二维码，并在钉钉中确认登录</p>
          <div className="dx-login-qr-frame">{qr}</div>
          <div className="dx-login-action">{action}</div>
          <p className="dx-login-status" role="status" aria-live="polite">
            <span aria-hidden="true">ⓘ</span><span>{message}</span>
          </p>
        </section>
      </div>
      <footer className="dx-login-filing">
        <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">粤ICP备2026043374号-1</a>
        <span className="dx-login-filing-divider" aria-hidden="true">|</span>
        <span>粤公网安备44011102484833号</span>
      </footer>
    </main>
  );
}
