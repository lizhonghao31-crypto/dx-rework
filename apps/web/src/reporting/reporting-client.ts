import {
  ManagementDashboardResponseSchema,
  ManagementReworkPageSchema,
  ReportPreviewResponseSchema,
  SiteDashboardResponseSchema,
  type ManagementDashboardResponse,
  type ManagementReworkPage,
  type ReportPreviewResponse,
  type ReportType,
  type SiteDashboardResponse,
} from "@dx-rework/contracts/reporting";

import { createWebUrls } from "../../url-contract.js";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

const request = async <T>(
  path: string,
  schema: { parse(value: unknown): T },
  signal?: AbortSignal,
): Promise<T> => {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const value = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(value?.error?.message ?? `请求失败（${response.status}）`);
  }
  return schema.parse(await response.json());
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

export const loadReworkOrders = (
  filters: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<ManagementReworkPage> => request(
  `management/rework-orders${queryString(filters)}`,
  ManagementReworkPageSchema,
  signal,
);

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

const businessDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Singapore",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const reportingBusinessDate = (value = new Date()): string => businessDateFormatter.format(value);
export const reportingBusinessMonthStart = (value = new Date()): string => `${reportingBusinessDate(value).slice(0, 7)}-01`;
