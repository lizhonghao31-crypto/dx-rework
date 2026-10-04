import type { DigitalTask } from "./digital-production-tasks.js";
export type CockpitStage = "development" | "bulk";
export type CockpitRow = {
  id: string; orderId: string | null; sourceId: string | null; styleNo: string;
  customer: string; category: string; designer: string; merchandiser: string | null;
  flow?: {key:string;label:string;state:DigitalTask["state"]|"uncreated"|"unavailable";taskId:string|null}[];
  styleImageId?: string | null;
  deliveryDate: string | null; createdAt: string;
  tasks: DigitalTask[];
  progress: { completed: number; applicable: number } | null;
  lines: { id: string; po: string | null; color: string; quantity: number }[];
};
export type CockpitResult = {
  actorId: string; actorName: string; canViewTodos: boolean; canManagePolicies: boolean; page: number; total: number;
  summary: { active: number; blocked: number; overdue: number; dueSoon: number; unknown: number };
  items: CockpitRow[];
};
