import { z } from "zod";
import { DevelopmentWorkspaceFilterSchema, PatternWorkspaceFilterSchema } from "@dx-rework/contracts/digital-development-workspace";
import { createWebUrls } from "../url-contract.js";

/** Allow only the two local read workspaces, with validated filters and selected task. */
export function developmentWorkspaceReturnUrl(value: string | null): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return null;
  try {
    const urls = createWebUrls(import.meta.env.BASE_URL), url = new URL(value, "https://local.invalid");
    if (url.hash || [...url.searchParams.keys()].length !== new Set(url.searchParams.keys()).size) return null;
    const query = Object.fromEntries(url.searchParams);
    if (url.pathname === urls.pageUrl("ui/digital-pattern-room") && PatternWorkspaceFilterSchema.safeExtend({task: z.string().uuid().optional()}).safeParse(query).success) return url.pathname + url.search;
    if (url.pathname === urls.pageUrl("ui/digital-production") && DevelopmentWorkspaceFilterSchema.safeExtend({workspace: z.literal("designer")}).safeParse(query).success) return url.pathname + url.search;
  } catch { /* A malformed return target has no navigation effect. */ }
  return null;
}
export function DevelopmentWorkspaceReturn() {
  const target = developmentWorkspaceReturnUrl(new URLSearchParams(window.location.search).get("returnTo"));
  return target ? <a className="dx-button dx-button--secondary" href={target}>返回开发工作台</a> : null;
}
