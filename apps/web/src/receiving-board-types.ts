import type {PackingActualTime} from '@dx-rework/contracts';
export type ReworkStatus = "draft" | "active" | "completed" | null;
export type BoardStatus = "all" | "normal" | "extra" | "short" | "multiple" | "receiving_difference" | "packing_difference" | "missing_packing" | "pending" | "handled" | "stale";

export type ReceivingHistoryItem = Readonly<{
  receiptId: string;
  receivingBatchId: string;
  batchVersion: number;
  sequence: number;
  documentQuantity: number;
  receiptDocumentQuantity: number;
  receivingSource: "legacy" | "initial" | "backfill" | "jiashun" | "other_factory";
  actualQuantity: number;
  defectiveQuantity: number;
  cumulativeActualQuantity: number;
  differenceQuantity: number;
  receivedAt: string;
  receiverName: string;
}>;
export type ReceivingAttachment = Readonly<{ attachmentId: string; filename: string }>;
export type DifferenceResolution = Readonly<{
  resolutionId: string;
  result: string;
  handledBy: string;
  handledAt: string;
  attachments?: readonly ReceivingAttachment[];
}>;

export type BoardRow = Readonly<{
  receivingBatchId: string;
  styleNo: string;
  documentQuantity: number;
  attachments: readonly ReceivingAttachment[];
  priorActualQuantity: number;
  actualQuantity: number;
  defectiveQuantity: number;
  currentActualQuantity: number;
  currentDefectiveQuantity: number;
  cumulativeActualQuantity: number;
  differenceQuantity: number;
  packingRevisionId: string | null;
  packingQuantity: number | null;
  packingDifferenceQuantity: number | null;
  packingRecordedBy: string | null;
  packingRecordedAt: string | null;
  packingActualTime?:PackingActualTime;
  packingScopeUnresolved?:boolean;
  actualCutCount: number | null;
  cuttingRecordedBy: string | null;
  cuttingRecordedAt: string | null;
  receivingDifferenceResolution: DifferenceResolution | null;
  packingDifferenceResolution: DifferenceResolution | null;
  staleResolution?: boolean;
  resolutionHistory?: readonly (DifferenceResolution & { differenceType: "receiving" | "packing"; differenceQuantity: number })[];
  receiptCount: number;
  receivingHistory: readonly ReceivingHistoryItem[];
  lastReceivedAt: string;
  lastReceiverName: string;
  reworkOrderId: string | null;
  reworkStatus: ReworkStatus;
  version: number;
  rootCorrectable: boolean;
  rootDeletable: boolean;
  rootMutable: boolean;
}>;

export type BoardResult = Readonly<{
  date: string;
  startDate: string;
  endDate: string;
  mode: "range" | "search";
  status: BoardStatus;
  insights?: Readonly<{ pendingCount: number; missingPackingCount: number; staleCount: number }>;
  kpis: Readonly<{
    orderCount: number;
    receivedQuantity: number;
    abnormalOrderCount: number;
    differenceQuantity: number;
    differenceRate: number;
  }>;
  rows: readonly BoardRow[];
  page: number;
  pageSize: 15;
  totalCount: number;
  totalPages: number;
}>;
