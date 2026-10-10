type InitiationAccessInput = Readonly<{
  canHandleInitiation: boolean;
  currentUserId: string | null;
  createdByUserId: string;
  isRoot: boolean;
  status: string;
}>;

/** Root manages N01 across creators; ordinary QC maintains only its own orders. */
export function reworkInitiationAccess(input: InitiationAccessInput) {
  const isOwnOrder = input.currentUserId !== null && input.currentUserId === input.createdByUserId;
  const canTransition = input.canHandleInitiation && (isOwnOrder || input.isRoot)
    && input.status === "pending_process_configuration";
  return {
    isOwnOrder,
    canEditDraft: input.canHandleInitiation && input.status === "draft" && (isOwnOrder || input.isRoot),
    canWithdraw: canTransition,
    canCancel: canTransition,
  };
}

/** Select the latest node before publishing state, so render cannot retain the old URL node. */
export function publishReworkNodeRefresh<T>(
  latest: T,
  nextNode: string | undefined,
  selectNode: (node: string) => void,
  publish: (latest: T) => void,
): void {
  if (nextNode) selectNode(nextNode);
  publish(latest);
}
