import { z } from "zod";
import { DigitalAnalysisFilterSchema } from '@dx-rework/contracts/digital-production-analysis';
import { DevelopmentWorkspaceFilterSchema, PatternWorkspaceFilterSchema } from "@dx-rework/contracts/digital-development-workspace";
import { createWebUrls } from "../url-contract.js";
import {documentCategories,documentChapterIds,taskTabLabels} from './digital-detail-context.js';

const designerDocumentKeys=['round','instructionVersion','budgetVersion','documentCategory','documentChapter','documentKind'] as const;
const selectedDocumentVersion=z.union([z.literal('current'),z.string().regex(/^[1-9]\d*$/).refine(value=>Number.isSafeInteger(Number(value)))]).optional();
const designerReturnSchema=DevelopmentWorkspaceFilterSchema.safeExtend({
  workspace:z.literal('designer'),selected:z.string().uuid().optional(),development:z.string().uuid().optional(),
  round:z.string().regex(/^[1-9]\d*$/).refine(value=>Number.isSafeInteger(Number(value))).optional(),
  documentCategory:z.enum(documentCategories).optional(),documentChapter:z.enum(documentChapterIds).optional(),
  documentKind:z.enum(['development','instruction','budget']).optional(),
  instructionVersion:selectedDocumentVersion,budgetVersion:selectedDocumentVersion,
});

/** Allow only local read workspaces, with validated filters and selected task. */
export function developmentWorkspaceReturnUrl(value: string | null, base: string = import.meta.env.BASE_URL): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  try {
    const urls = createWebUrls(base), url = new URL(value, "https://local.invalid");
    if (url.origin !== "https://local.invalid" || url.hash || [...url.searchParams.keys()].length !== new Set(url.searchParams.keys()).size) return null;
    const query = Object.fromEntries(url.searchParams);
    const {view:analysisView,...analysisFilters}=query;
    if (url.pathname === urls.pageUrl('ui/digital-analysis') && z.enum(['output','timing','waiting','quality']).safeParse(analysisView).success && DigitalAnalysisFilterSchema.safeParse(analysisFilters).success) return url.pathname + url.search;
    if (url.pathname === urls.pageUrl("ui/digital-pattern-room") && PatternWorkspaceFilterSchema.safeExtend({section:z.enum(["development","bulk"]).optional(),bulkOrder:z.string().uuid().optional(),task: z.string().uuid().optional(), taskView: z.enum(["read","handle","correct"]).optional(),taskTab:z.enum(Object.keys(taskTabLabels) as [keyof typeof taskTabLabels,...Array<keyof typeof taskTabLabels>]).optional(),documentCategory:z.enum(documentCategories).optional(),documentChapter:z.enum(documentChapterIds).optional(),documentKind:z.enum(["development","instruction","budget"]).optional(),round:z.union([z.literal("current"),z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)]).optional(),instructionVersion:z.union([z.literal("current"),z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)]).optional(),budgetVersion:z.union([z.literal("current"),z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)]).optional()}).safeParse(query).success) return url.pathname + url.search;
    if (url.pathname === urls.pageUrl("ui/digital-production")) {
      const designer=designerReturnSchema.safeParse(query);
      if(designer.success&&(designer.data.development||!designerDocumentKeys.some(key=>url.searchParams.has(key))))return url.pathname+url.search;
    }
  } catch { /* A malformed return target has no navigation effect. */ }
  return null;
}
export function DevelopmentWorkspaceReturn() {
  const query=new URLSearchParams(window.location.search);
  if(["development","instruction","budget","task","bulk"].some(kind=>query.has(kind)))return null;
  if(query.get("workbench")==="sample"&&query.has("task"))return null;
  const target = developmentWorkspaceReturnUrl(query.get("returnTo"));
  return target ? <a className="dx-button dx-button--secondary" href={target}>{target.startsWith(createWebUrls(import.meta.env.BASE_URL).pageUrl('ui/digital-analysis'))?'返回板房沙盘':'返回开发工作台'}</a> : null;
}
