import { describe, expect, it } from "vitest";

import { todoPageWindow } from "../../apps/web/src/todo-pagination.js";

describe("my todo numeric pagination window", () => {
  it("keeps five directly clickable pages around the current page", () => {
    expect(todoPageWindow(1, 30)).toEqual([1, 2, 3, 4, 5]);
    expect(todoPageWindow(8, 30)).toEqual([6, 7, 8, 9, 10]);
    expect(todoPageWindow(30, 30)).toEqual([26, 27, 28, 29, 30]);
  });

  it("always exposes page one for an empty or single-page result", () => {
    expect(todoPageWindow(1, 0)).toEqual([1]);
    expect(todoPageWindow(1, 1)).toEqual([1]);
  });
});
