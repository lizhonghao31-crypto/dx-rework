import type { InputHTMLAttributes } from "react";
import { isNewSourcingPrice, newSourcingPriceDisplay } from "./sourcing-price-presentation.js";

const editable = (value: string): boolean => /^(?:\d+(?:\.\d*)?)?$/.test(value);
const characterError = "价格仅支持数字和小数点";

/** Only a complete, correctly grouped pasted amount may lose its separators. */
export function pastedSourcingPrice(text: string): string | null {
  const value = text.trim();
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(value)) return value.replace(/,/g, "");
  return value && editable(value) ? value : null;
}

export function sourcingPriceError(value: string): string | null {
  if (isNewSourcingPrice(value)) return null;
  if (!value || value.endsWith(".")) return "请填写有效价格";
  if (/^0+(?:\.0+)?$/.test(value)) return "价格必须大于0";
  if ((value.split(".")[1] ?? "").replace(/0+$/, "").length > 2) return "最多2位有效小数";
  return "价格超出允许范围或格式无效";
}

/** Local to the IE/management inputs. Composition text never enters business state. */
export function createSourcingPriceInput(onValue: (value: string) => void, notify: () => void) {
  let accepted = "";
  let focused = false;
  let composing = false;
  let draft = "";
  let error: string | null = null;
  let selection: [number, number] = [0, 0];
  let compositionSelection: [number, number] = [0, 0];
  let rejectedComposition = false;
  const remember = (input: HTMLInputElement): void => {
    selection = [input.selectionStart ?? 0, input.selectionEnd ?? 0];
  };
  const reject = (input: HTMLInputElement, caret = selection): void => {
    input.value = accepted;
    input.setSelectionRange(...caret);
    error = characterError;
    notify();
  };
  const accept = (value: string): void => {
    accepted = value;
    error = focused && (!value || value.endsWith(".")) ? null : sourcingPriceError(value);
    onValue(value);
    notify();
  };
  return {
    sync(value: string): void { accepted = value; },
    get composing(): boolean { return composing; },
    get error(): string | null { return error; },
    get props(): InputHTMLAttributes<HTMLInputElement> {
      return {
        value: composing ? draft : focused ? accepted : newSourcingPriceDisplay(accepted),
        inputMode: "decimal",
        "aria-invalid": !!error,
        onFocus(event) {
          const input = event.currentTarget;
          const start = input.selectionStart ?? 0, end = input.selectionEnd ?? start;
          const rawStart = start === input.value.length ? accepted.length : input.value.slice(0, start).replace(/,/g, "").length;
          const rawEnd = end === input.value.length ? accepted.length : input.value.slice(0, end).replace(/,/g, "").length;
          focused = true;
          input.value = accepted;
          input.setSelectionRange(rawStart, rawEnd);
          remember(input);
          notify();
        },
        onSelect(event) { if (!composing) remember(event.currentTarget); },
        onBeforeInput(event) {
          if (composing) return;
          rejectedComposition = false;
          const input = event.currentTarget;
          remember(input);
          const data = (event as unknown as { data?: string }).data ?? (event.nativeEvent as InputEvent).data;
          if (data != null && !editable(accepted.slice(0, selection[0]) + data + accepted.slice(selection[1]))) {
            event.preventDefault();
            error = characterError;
            notify();
          }
        },
        onChange(event) {
          const input = event.currentTarget;
          if (composing) { draft = input.value; notify(); return; }
          // Some browsers emit a final change immediately after compositionend.
          if (rejectedComposition && input.value === accepted) { rejectedComposition = false; return; }
          rejectedComposition = false;
          if (!editable(input.value)) { reject(input); return; }
          accept(input.value);
          remember(input);
        },
        onPaste(event) {
          if (composing) { event.preventDefault(); return; }
          event.preventDefault();
          rejectedComposition = false;
          const input = event.currentTarget;
          remember(input);
          const pasted = pastedSourcingPrice(event.clipboardData.getData("text"));
          const next = pasted === null ? null : accepted.slice(0, selection[0]) + pasted + accepted.slice(selection[1]);
          if (next === null || !editable(next)) { reject(input); return; }
          const caret = selection[0] + pasted!.length;
          input.value = next;
          input.setSelectionRange(caret, caret);
          accept(next);
          remember(input);
        },
        onCompositionStart(event) {
          remember(event.currentTarget);
          compositionSelection = selection;
          composing = true;
          draft = event.currentTarget.value;
          rejectedComposition = false;
          notify();
        },
        onCompositionEnd(event) {
          if (!composing) return;
          composing = false;
          const input = event.currentTarget;
          if (!editable(input.value)) {
            rejectedComposition = true;
            reject(input, compositionSelection);
          } else { accept(input.value); remember(input); }
        },
        onBlur() {
          focused = false;
          error = error ?? sourcingPriceError(accepted);
          notify();
        },
      };
    },
  };
}
