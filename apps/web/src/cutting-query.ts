import { CuttingOrderQuerySchema, type CuttingOrderDetail } from "@dx-rework/contracts";
import { DigitalIdSchema } from '@dx-rework/contracts/digital-production';

import {digitalDetailReturnUrl} from "./digital-detail-route.js";
import {normalizeBasePath} from "../url-contract.js";

export type CuttingListQuery = {
  q: string;
  status: "all" | "pending" | "recorded";
  outOfRange: boolean;
  page: number;
};

export function readCuttingListQuery(search: string): CuttingListQuery {
  const params = new URLSearchParams(search);
  const input: Record<string, string> = {};
  for (const key of ["q", "status", "outOfRange", "page"]) {
    const value = params.get(key);
    if (value) input[key] = value;
  }
  const parsed = CuttingOrderQuerySchema.safeParse(input);
  const value = parsed.success ? parsed.data : CuttingOrderQuerySchema.parse({});
  return {
    q: value.q,
    status: value.status,
    outOfRange: value.outOfRange === "true",
    page: value.page,
  };
}

export function cuttingListPath(query: CuttingListQuery): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.status !== "all") params.set("status", query.status);
  if (query.outOfRange) params.set("outOfRange", "true");
  if (query.page > 1) params.set("page", String(query.page));
  return `/ui/cutting${params.size ? `?${params}` : ""}`;
}

export function cuttingReturnPath(search: string,base="/"): string {
  const target = new URLSearchParams(search).get("returnTo");
  const domain=target?digitalDetailReturnUrl(target,base):null;
  if(domain){const prefix=normalizeBasePath(base).slice(0,-1);return prefix&&domain.startsWith(prefix+"/")?domain.slice(prefix.length):domain;}
  if (!target || target.includes("\\") || target.includes("#")) return "/ui/cutting";
  if (target.split("?")[0] !== "/ui/cutting") return "/ui/cutting";
  const targetSearch = target.includes("?") ? target.slice(target.indexOf("?")) : "";
  return cuttingListPath(readCuttingListQuery(targetSearch));
}

/** A history link must match the saved original and must never open current writes on error. */
export function cuttingOriginalSelection(search:string){
  const query=new URLSearchParams(search);
  if(!query.has('cuttingRecord')&&!query.has('cuttingVersion'))return undefined;
  const recordId=DigitalIdSchema.safeParse(query.get('cuttingRecord')),text=query.get('cuttingVersion');
  if(query.getAll('cuttingRecord').length!==1||query.getAll('cuttingVersion').length!==1||!recordId.success||
    !text||!/^[1-9]\d*$/.test(text)||!Number.isSafeInteger(Number(text)))return null;
  return {recordId:recordId.data,version:Number(text)};
}

export function cuttingOriginalRecord(record:CuttingOrderDetail['record'],selection:ReturnType<typeof cuttingOriginalSelection>){
  if(!selection||!record||record.cuttingRecordId!==selection.recordId)return null;
  if(selection.version===1)return {
    version:1,pieceCount:record.initialPieceCount,actualCutCount:record.initialActualCutCount,
    recordedAt:record.recordedAt,recordedByName:record.recordedByName,reason:null,photos:record.cuttingSheetPhotos,
  };
  const correction=record.corrections.find(item=>item.version===selection.version);
  if(!correction)return null;
  return {version:correction.version,pieceCount:correction.pieceCount,actualCutCount:correction.actualCutCount,
    recordedAt:correction.correctedAt,recordedByName:correction.correctedByName,reason:correction.reason,photos:[]};
}
