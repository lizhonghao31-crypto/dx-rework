import {feedbackFetch,feedbackJson,invalidResponseMessage} from '../request-response-feedback.js';
import { settleWageBatches } from "../wages/wage-settlement-batches.js";
import {
  BasicReworkPageSchema,
  WageSettlementPreviewSchema, WageSettlementResultSchema,
  ManagementDashboardResponseSchema,
  ManagementReworkPageSchema,
  ManagementReworkQueueSchema,
  ReportPreviewResponseSchema,
  SiteDashboardResponseSchema,
  type ManagementDashboardResponse,
  type ManagementReworkPage,
  type ReportPreviewResponse,
  type ReportType,
  type SiteDashboardResponse,
} from "@dx-rework/contracts/reporting";
import { DeleteReworkOrderResponseSchema } from "@dx-rework/contracts";

import { createWebUrls } from "../../url-contract.js";
import { createClientRequestId } from "../client-request-id.js";
import { shanghaiBusinessDate } from "../business-date.js";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

const request = async <T>(
  path: string,
  schema: { parse(value: unknown): T },
  signal?: AbortSignal,
): Promise<T> => {
  const response = await feedbackFetch(apiUrl(path), {
    credentials: "include",headers:{accept:"application/json"},...(signal?{signal}:{}),
  });
  return feedbackJson(response,'GET',value=>schema.parse(value));
};

const queryString = (values: Record<string, string | undefined>): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) query.set(key, value);
  const text = query.toString();
  return text ? `?${text}` : "";
};

export const loadManagementDashboard = (
  mode: "management" | "site",
  signal?: AbortSignal,
): Promise<ManagementDashboardResponse | SiteDashboardResponse> => mode === "management"
  ? request("management/dashboard", ManagementDashboardResponseSchema, signal)
  : request("site/dashboard", SiteDashboardResponseSchema, signal);

export const loadBasicReworkOrders = (filters: Record<string,string | undefined>, signal?: AbortSignal) =>
  request(`management/rework-basic-orders${queryString(filters)}`,BasicReworkPageSchema,signal);

export const loadReworkOrders = (
  filters: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<ManagementReworkPage> => request(
  `management/rework-orders${queryString(filters)}`,
  ManagementReworkPageSchema,
  signal,
);

export const loadReworkQueue = (filters: Record<string,string | undefined>, signal?: AbortSignal) =>
  request(`management/rework-workflow-queue${queryString(filters)}`,ManagementReworkQueueSchema,signal);

export const deleteReworkOrder = async (reworkOrderId: string): Promise<void> => {
  const response = await feedbackFetch(apiUrl(`rework-orders/${reworkOrderId}`), {
    method: "DELETE",
    credentials: "include",
    headers: {
      accept: "application/json",
      "idempotency-key": `root-delete-${createClientRequestId()}`,
    },
  });
  await feedbackJson(response,'DELETE',value=>DeleteReworkOrderResponseSchema.parse(value));
};

export const loadReport = (
  reportType: ReportType,
  filters: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<ReportPreviewResponse> => request(
  `management/reports/${reportType}${queryString(filters)}`,
  ReportPreviewResponseSchema,
  signal,
);

export const reportExportUrl = (
  reportType: ReportType,
  filters: Record<string, string | undefined>,
): string => apiUrl(`management/reports/${reportType}/export.xlsx${queryString(filters)}`);

export const reportingPageUrl = (path: string): string => pageUrl(path);

export const reportingBusinessDate = (value = new Date()): string => shanghaiBusinessDate(value);
export const reportingBusinessMonthStart = (value = new Date()): string => `${reportingBusinessDate(value).slice(0, 7)}-01`;

export const previewWageSettlement = (filters: Record<string,string | undefined>) => request(
  `management/wages/settlement-preview${queryString(filters)}`,WageSettlementPreviewSchema);
export const markWageSettlement = (filters: Record<string,string | undefined>,lineIds:string[]) =>
 settleWageBatches(lineIds,ids=>markWageSettlementBatch(filters,ids));
const markWageSettlementBatch = async (filters: Record<string,string | undefined>,lineIds:string[]) => {
 const response=await feedbackFetch(apiUrl("management/wages/settlement"),{
  method:"POST",credentials:"include",headers:{"content-type":"application/json",accept:"application/json"},
  body:JSON.stringify({filters,lineIds}),
 });
 return feedbackJson(response,'POST',value=>WageSettlementResultSchema.parse(value));
};

/** Same synchronous GET, filters, authorization and server filename; no export task is created. */
export async function downloadReportExport(reportType:ReportType,filters:Record<string,string|undefined>,signal?:AbortSignal){
 const response=await feedbackFetch(reportExportUrl(reportType,filters),{credentials:'include',headers:{accept:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},...(signal?{signal}:{})});
 if(!response.ok)await feedbackJson(response,'GET',value=>value);
 if(response.headers.get('content-type')?.toLowerCase().split(';')[0]?.trim()!=='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')throw Error('导出尚未取得有效Excel文件，请在原筛选范围重试读取；仍失败时请管理员核查');
 let blob:Blob;try{blob=await response.blob();const signature=new Uint8Array(await blob.slice(0,4).arrayBuffer());if(signature[0]!==0x50||signature[1]!==0x4b||signature[2]!==3||signature[3]!==4)throw Error('invalid file');}catch(error){if((error as Error)?.name==='AbortError')throw error;throw Error(invalidResponseMessage('GET'));}
 const disposition=response.headers.get('content-disposition')??'';
 let filename=disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]??disposition.match(/filename="([^"]+)"/i)?.[1]??`report-${reportType}.xlsx`;
 try{filename=decodeURIComponent(filename);}catch{filename=`report-${reportType}.xlsx`;}
 filename=filename.replace(/[/\\\p{Cc}]/gu,'_');if(!filename.toLowerCase().endsWith('.xlsx'))filename=`report-${reportType}.xlsx`;
 return {blob,filename};
}
