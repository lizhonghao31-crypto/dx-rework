/** One confirmation and one cleanup for both in-page selection and route changes. */
export function createSupplierDraftGuard(options: {
  isBlocked: () => boolean;
  confirm: () => Promise<boolean>;
  discard: () => void;
}) {
  let dirty = false;
  let pending = false;
  return {
    get pending() { return pending; },
    get shouldBlock() { return dirty || pending || options.isBlocked(); },
    setDirty(value: boolean) { dirty = value; },
    markClean() { dirty = false; },
    async requestLeave(): Promise<boolean> {
      if (pending || options.isBlocked()) return false;
      if (!dirty) return true;
      pending = true;
      try {
        if (!await options.confirm() || options.isBlocked()) return false;
        // Clear synchronously, before the router resumes or React renders.
        dirty = false;
        options.discard();
        return true;
      } finally { pending = false; }
    },
  };
}
