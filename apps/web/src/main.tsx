import { configureChineseValidation } from "@dx-rework/contracts/validation-language";
import { installChineseNativeValidation } from "./native-validation.js";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import {lazyBusinessPage} from './lazy-business-page.js';
import "@dx-rework/ui/tokens.css";
import "@dx-rework/ui/components.css";
import "./styles.css";
import "./responsibility-determination.css";
import "./workflow-shell.css";
import "./dialog-visual-system.css";
import "./workflow-state-visual.css";
import "./ui-polish.css";

const AcceptanceLabPage=lazyBusinessPage(()=>import('./acceptance-lab-page.js').then(module=>({default:module.AcceptanceLabPage})),{shellOnError:false});

const AcceptanceProductionCommandCenterPage = lazy(async () => {
  const module = await import("./acceptance-production-command-center-page.js");
  return { default: module.AcceptanceProductionCommandCenterPage };
});

configureChineseValidation();
const removeNativeValidation = installChineseNativeValidation(document);
import.meta.hot?.dispose(removeNativeValidation);

const root = document.getElementById("root");
if (!root) throw new Error("Root element is missing");

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const acceptanceLabPath = `${basePath}/ui/acceptance-lab`;
const acceptanceCommandCenterPath = `${basePath}/ui/acceptance/production-command-center`;
const page = window.location.pathname === acceptanceLabPath
  ? <AcceptanceLabPage />
  : window.location.pathname === acceptanceCommandCenterPath
    ? <Suspense fallback={null}><AcceptanceProductionCommandCenterPage /></Suspense>
    : <App />;

function mountApp(container: HTMLElement) {
  createRoot(container).render(<StrictMode>{page}</StrictMode>);
}

function entryStylesReady(links: HTMLLinkElement[]) {
  if (getComputedStyle(document.documentElement).getPropertyValue("--dx-entry-shell-css").trim() !== "ready") return false;
  return links.every(link => {
    try {
      return Boolean(link.sheet?.cssRules.length);
    } catch {
      return false;
    }
  });
}

const entryStyles = [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
  .filter(link => new URL(link.href).origin === window.location.origin);

if (!import.meta.env.PROD || entryStylesReady(entryStyles)) {
  mountApp(root);
} else {
  // This startup message must remain readable when an entry stylesheet fails.
  // Expose no unstyled shell. A retry is an explicit full reload.
  const fallback = document.createElement("main");
  fallback.style.cssText = "max-width:40rem;margin:3rem auto;padding:1rem;font:1rem/1.5 system-ui,sans-serif";
  const message = document.createElement("p");
  fallback.setAttribute("role", "status");
  message.textContent = "正在加载界面样式…";
  fallback.append(message);
  root.replaceChildren(fallback);
  const container = root;
  const finish = () => {
    window.clearTimeout(timeout);
    window.removeEventListener("load", finish);
    if (entryStylesReady(entryStyles)) {
      mountApp(container);
      return;
    }
    fallback.setAttribute("role", "alert");
    message.textContent = "页面样式暂时未能加载，请刷新重试。";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "刷新页面";
    retry.addEventListener("click", () => window.location.reload());
    fallback.append(retry);
  };
  const timeout = window.setTimeout(finish, 10000);
  if (document.readyState === "complete") finish();
  else window.addEventListener("load", finish, { once: true });
}

import "./scoped-select-arrow.css";
