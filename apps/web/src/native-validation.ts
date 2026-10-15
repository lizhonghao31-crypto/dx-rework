/** Localize existing HTML constraints only. Never add required/min/max or interfere with domain validity. */
export function installChineseNativeValidation(root: Document): () => void {
  const owned = new WeakMap<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, string>();
  const isControl = (target: EventTarget | null): target is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
    target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
  const clearOwned = (field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => {
    if (owned.get(field) === field.validationMessage) { field.setCustomValidity(""); owned.delete(field); }
  };
  const clear = (event: Event) => {
    if (!isControl(event.target)) return;
    // Another field can change this field's conditional required/min/max. Drop
    // only our display messages; native constraints are evaluated again on submit.
    if (event.target.form) Array.from(event.target.form.elements).forEach(field => { if (isControl(field)) clearOwned(field); });
    else clearOwned(event.target);
  };
  let pendingFocus: number | null = null;
  const invalid = (event: Event) => {
    const field = event.target;
    if (!isControl(field) || field.disabled) return;
    if (pendingFocus === null) {
      const target = field.getAttribute("aria-hidden") === "true"
        ? field.closest(".native-search-select")?.querySelector<HTMLInputElement>('input[role="combobox"]') : field;
      if (target) pendingFocus = requestAnimationFrame(() => {
        pendingFocus = null;
        if (!target.isConnected) return;
        for (let parent = target.parentElement; parent; parent = parent.parentElement) {
          if (parent instanceof HTMLDetailsElement) parent.open = true;
        }
        target.focus();
      });
    }
    if (field.getAttribute("aria-hidden") === "true") return;
    if (field.validity.customError && owned.get(field) !== field.validationMessage) return;
    const labelNode = field.labels?.[0]?.cloneNode(true) as HTMLElement | undefined;
    labelNode?.querySelectorAll("input,select,textarea,button,small").forEach(node => node.remove());
    const label = (field.getAttribute("aria-label") || labelNode?.textContent || ("placeholder" in field ? field.placeholder : "") || "填写内容").trim().replace(/[*＊]$/, "").trim();
    const validity = field.validity;
    const reason = validity.valueMissing ? (field instanceof HTMLSelectElement ? "请选择已有选项" : "请填写此项")
      : validity.typeMismatch ? "请填写正确的邮箱或网址格式"
      : validity.rangeUnderflow && field instanceof HTMLInputElement ? `不能小于${field.min}`
      : validity.rangeOverflow && field instanceof HTMLInputElement ? `不能大于${field.max}`
      : validity.tooLong ? "内容超过允许长度"
      : validity.tooShort ? "内容长度不足"
      : validity.stepMismatch ? "请按允许的数量间隔填写"
      : validity.badInput ? "请填写有效数值或日期"
      : "格式不正确，请按字段说明填写";
    const message = `${label}：${reason}`;
    field.setCustomValidity(message); owned.set(field, message);
    // Expand ancestors before the browser focuses its first invalid field.
    for (let parent = field.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
  };
  root.addEventListener("invalid", invalid, true);
  root.addEventListener("input", clear, true);
  root.addEventListener("change", clear, true);
  return () => {
    if (pendingFocus !== null) cancelAnimationFrame(pendingFocus);
    root.removeEventListener("invalid", invalid, true);
    root.removeEventListener("input", clear, true);
    root.removeEventListener("change", clear, true);
  };
}
