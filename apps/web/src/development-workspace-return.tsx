import { z } from "zod";
import { DigitalAnalysisFilterSchema } from '@dx-rework/contracts/digital-production-analysis';
import { DevelopmentWorkspaceFilterSchema, PatternWorkspaceFilterSchema } from "@dx-rework/contracts/digital-development-workspace";
import { createWebUrls } from "../url-contract.js";

/** Allow only local read workspaces, with validated filters and selected task. */
export function developmentWorkspaceReturnUrl(value: string | null, base: string = import.meta.env.BASE_URL): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  try {
    const urls = createWebUrls(base), url = new URL(value, "https://local.invalid");
    if (url.origin !== "https://local.invalid" || url.hash || [...url.searchParams.keys()].length !== new Set(url.searchParams.keys()).size) return null;
    const query = Object.fromEntries(url.searchParams);
    if (url.pathname === urls.pageUrl('ui/digital-analysis') && DigitalAnalysisFilterSchema.safeExtend({view:z.enum(['output','timing','waiting','quality'])}).safeParse(query).success) return url.pathname + url.search;
    if (url.pathname === urls.pageUrl("ui/digital-pattern-room") && PatternWorkspaceFilterSchema.safeExtend({task: z.string().uuid().optional(), taskView: z.enum(["read","handle","correct"]).optional()}).safeParse(query).success) return url.pathname + url.search;
    if (url.pathname === urls.pageUrl("ui/digital-production") && DevelopmentWorkspaceFilterSchema.safeExtend({workspace: z.literal("designer"), selected: z.string().uuid().optional()}).safeParse(query).success) return url.pathname + url.search;
  } catch { /* A malformed return target has no navigation effect. */ }
  return null;
}
export function DevelopmentWorkspaceReturn() {
  const query=new URLSearchParams(window.location.search);
  if(["development","instruction","budget"].some(kind=>query.has(kind)))return null;
  if(query.get("workbench")==="sample"&&query.has("task"))return null;
  const target = developmentWorkspaceReturnUrl(query.get("returnTo"));
  return target ? <a className="dx-button dx-button--secondary" href={target}>{target.startsWith(createWebUrls(import.meta.env.BASE_URL).pageUrl('ui/digital-analysis'))?'返回板房沙盘':'返回开发工作台'}</a> : null;
}
