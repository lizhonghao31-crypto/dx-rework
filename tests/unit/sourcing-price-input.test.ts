import { describe, expect, it, vi } from "vitest";
import { createSourcingPriceInput, pastedSourcingPrice, sourcingPriceError } from "../../apps/web/src/sourcing-price-input.js";
import { isNewSourcingPrice } from "../../apps/web/src/sourcing-price-presentation.js";

// Exercise the production event handlers; this is not a browser/IME acceptance test.
function field(initial = "10.8") {
  let price = initial;
  const commit = vi.fn((value: string) => { price = value; });
  const control = createSourcingPriceInput(commit, vi.fn());
  control.sync(initial);
  const input = {
    value: String(control.props.value), selectionStart: 0, selectionEnd: 0,
    setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; },
  };
  const fire = (name: "onFocus" | "onBlur" | "onSelect" | "onBeforeInput" | "onChange" | "onPaste" | "onCompositionStart" | "onCompositionEnd", extra = {}) => {
    const event = { currentTarget: input, nativeEvent: {}, preventDefault: vi.fn(), ...extra };
    (control.props[name] as (event: unknown) => void)(event);
    return event;
  };
  fire("onFocus");
  return { control, input, fire, commit, get price() { return price; } };
}

describe("sourcing IE and management price editing", () => {
  it("rejects a whole mixed paste and validates thousands grouping without extracting digits", () => {
    for (const bad of ["10.8元", "10元8", "12,34.50", "1 234", "-10", "+10", "1e2", "10..8", "１２"]) {
      expect(pastedSourcingPrice(bad)).toBeNull();
      const f = field(); f.input.setSelectionRange(0, 4);
      expect(f.fire("onPaste", { clipboardData: { getData: () => bad } }).preventDefault).toHaveBeenCalled();
      expect(f.price).toBe("10.8"); expect(f.input.value).toBe("10.8");
      expect(f.control.error).toBe("价格仅支持数字和小数点");
    }
    const f = field(); f.input.setSelectionRange(0, 4);
    f.fire("onPaste", { clipboardData: { getData: () => " 1,234.50 " } });
    expect(f.price).toBe("1234.50"); expect(f.input.selectionStart).toBe(7);
    f.fire("onBlur"); expect(f.control.props.value).toBe("1,234.5");
  });

  it("rejects beforeinput and fallback changes while preserving the previous value and selection", () => {
    for (const data of ["元", "A", "-", "+", "."]) {
      const f = field(); f.input.setSelectionRange(2, 2);
      expect(f.fire("onBeforeInput", { data }).preventDefault).toHaveBeenCalled();
      expect(f.price).toBe("10.8");
      f.input.value = `10${data}.8`;
      f.fire("onChange");
      expect(f.input.value).toBe("10.8"); expect(f.input.selectionStart).toBe(2);
    }
  });

  it("allows middle editing, selection replacement, deletion and unfinished decimals without coercion", () => {
    const f = field(); f.input.setSelectionRange(1, 2);
    f.fire("onPaste", { clipboardData: { getData: () => "2" } });
    expect(f.price).toBe("12.8"); expect(f.input.selectionStart).toBe(2);
    for (const value of ["12.80", "10.", "", "0", "10.801", "10.8000"]) {
      f.input.value = value; f.fire("onChange"); expect(f.price).toBe(value);
    }
    expect(f.control.error).toBeNull();
    f.input.value = ""; f.fire("onChange"); expect(f.control.error).toBeNull();
    f.fire("onBlur"); expect(f.control.error).toBe("请填写有效价格");
    expect(isNewSourcingPrice("10.")).toBe(false);
    expect(sourcingPriceError("0")).toBe("价格必须大于0");
    expect(sourcingPriceError("10.801")).toBe("最多2位有效小数");
    expect(sourcingPriceError("10000000000")).toBeTruthy();
  });

  it("keeps composing text out of the quote and restores rejected text after confirmation", () => {
    const f = field(); f.input.setSelectionRange(4, 4); f.fire("onCompositionStart");
    for (const draft of ["10.8y", "10.8yuan", "10.8元"]) {
      f.input.value = draft; f.fire("onChange");
      expect(f.price).toBe("10.8"); expect(f.control.props.value).toBe(draft);
      expect(f.control.composing).toBe(true);
    }
    expect(f.commit).not.toHaveBeenCalled();
    f.fire("onCompositionEnd"); expect(f.control.composing).toBe(false);
    expect(f.input.value).toBe("10.8"); expect(f.input.selectionStart).toBe(4);
    f.fire("onChange"); expect(f.control.error).toBe("价格仅支持数字和小数点");
    f.input.value = "10.9"; f.fire("onChange"); expect(f.price).toBe("10.9"); expect(f.control.error).toBeNull();
  });

  it("accepts a numeric composition only when finished and preserves raw trailing zero selection on focus", () => {
    const f = field("1234.5000"); f.fire("onBlur");
    f.input.value = String(f.control.props.value); f.input.setSelectionRange(0, f.input.value.length);
    f.fire("onFocus"); expect(f.input.value).toBe("1234.5000"); expect(f.input.selectionEnd).toBe(9);
    f.fire("onCompositionStart"); f.input.value = "12"; f.fire("onChange");
    expect(f.price).toBe("1234.5000");
    f.fire("onCompositionEnd"); expect(f.price).toBe("12"); expect(f.control.error).toBeNull();
  });

  it("does not show initial errors or leak errors into another price input", () => {
    const empty = createSourcingPriceInput(vi.fn(), vi.fn()); empty.sync(""); expect(empty.error).toBeNull();
    const a = field(), b = field(); a.input.value = "元"; a.fire("onChange");
    expect(a.control.error).toBeTruthy(); expect(b.control.error).toBeNull(); expect(b.price).toBe("10.8");
  });
});
