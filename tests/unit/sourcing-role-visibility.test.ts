import { describe, expect, it } from "vitest";
import { isMerchandiserOnly } from "../../apps/web/src/sourcing-role-visibility.js";

describe("sourcing finance view by business role",()=>{
  it("hides the finance node for merchandiser-only accounts, including read-only merchandisers",()=>{
    expect(isMerchandiserOnly(["order_merchandiser"],false)).toBe(true);
  });
  it("preserves the finance view for multi-role accounts and Root",()=>{
    expect(isMerchandiserOnly(["order_merchandiser","production_management"],false)).toBe(false);
    expect(isMerchandiserOnly(["order_merchandiser","owner_group"],false)).toBe(false);
    expect(isMerchandiserOnly(["order_merchandiser"],true)).toBe(false);
  });
});
