import type {JourneyNode} from '@dx-rework/contracts/digital-production-journey';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';

/** Shared access flags for the existing designer, personnel and native task workspaces. */
export type DigitalAccessOptions = { manage: boolean; customers: boolean; approveDelivery: boolean; create: boolean; actorId: string; roles: string[] };

/** Settings reads do not turn the original management flag on. */
export const canReadDigitalProductionSettings = (access: DigitalAccessOptions | null | undefined) => Boolean(access?.manage || access?.roles?.includes('pmc'));
export const canReadAllDigitalPatternTasks = (roles: readonly string[] = []) => roles.some(role => ['root_superuser', 'owner_group', 'production_management', 'pmc', 'pattern_room_supervisor', 'development_clerk'].includes(role));
/** Navigation only. Board summaries mark every task read; detail retains execution authority. */
export const pmcPatternTaskReadOnly = (access: DigitalAccessOptions | null, node: Pick<JourneyNode, 'instanceId' | 'owner'>,
  task?: Pick<DigitalTask, 'taskId' | 'assigneeId' | 'requiredRole' | 'canExecute'> | null) => {
  if (!access?.roles?.includes('pmc')) return false;
  if (access.manage || access.create || access.roles.some(role => ['pattern_room_supervisor', 'development_clerk', 'order_merchandiser'].includes(role))) return false;
  if (!access.roles.some(role => ['pattern_room_worker', 'pattern_room_tail_inspector'].includes(role))) return true;
  if (task) return task.taskId !== node.instanceId || task.assigneeId !== access.actorId || !access.roles.includes(task.requiredRole) || !task.canExecute;
  // Preserve the original own-task route until the existing detail request checks the actual role and canExecute.
  return node.owner?.id !== access.actorId;
};
