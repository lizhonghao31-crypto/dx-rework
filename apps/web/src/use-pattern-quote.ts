import { useEffect, useState } from "react";
import { PatternPriceQuoteSchema, type PatternPriceItem } from "@dx-rework/contracts/pattern-room";
import { patternRequest } from "./pattern-order-client.js";

type Quote = Pick<PatternPriceItem, "priceId" | "name" | "unit" | "amount" | "version">;
export type PatternQuoteState = { status: "idle" | "loading"; quote: null } | { status: "ready"; quote: Quote } | { status: "error"; quote: null; message: string };

// A changed category/refresh invalidates the old quote immediately, before effects run.
export function usePatternQuote(path: string | null, revision: number): PatternQuoteState {
  const [result, setResult] = useState<{ path: string; revision: number; state: PatternQuoteState } | null>(null);
  useEffect(() => {
    if (!path) { setResult(null); return; }
    const abort = new AbortController();
    setResult({ path, revision, state: { status: "loading", quote: null } });
    void patternRequest(path, PatternPriceQuoteSchema, { signal: abort.signal }).then(quote => {
      if (!abort.signal.aborted) setResult({ path, revision, state: { status: "ready", quote } });
    }).catch(error => {
      if (!abort.signal.aborted) setResult({ path, revision, state: { status: "error", quote: null, message: error instanceof Error ? error.message : "价格读取失败，请重试" } });
    });
    return () => abort.abort();
  }, [path, revision]);
  if (!path) return { status: "idle", quote: null };
  return result?.path === path && result.revision === revision ? result.state : { status: "loading", quote: null };
}
