import { describe, expect, it, vi } from "vitest";
import { SubmissionAttempt } from "../../apps/web/src/submission-attempt.js";
import { SubmissionCancelled, SubmissionRequestError } from "../../apps/web/src/submission-validation.js";

describe("提交请求生命周期", () => {
  it("blocks a second synchronous click until the first operation settles", async () => {
    const attempt = new SubmissionAttempt();
    let finish!: () => void;
    const send = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = attempt.run(send);
    expect(await attempt.run(send)).toEqual({ kind: "busy" });
    expect(send).toHaveBeenCalledTimes(1);
    finish();
    expect(await first).toEqual({ kind: "success" });
    expect(attempt.hasPending).toBe(false);
  });
  it("recovers the original key and body, never the edited or newly supplied request", async () => {
    const attempt = new SubmissionAttempt();
    const original = { key: "original-key", body: JSON.stringify({ unitPrice: "12.30" }) };
    const requests: typeof original[] = [];
    let committed = false;
    const operation = async () => {
      requests.push(original);
      if (!committed) { committed = true; throw new TypeError("response lost after commit"); }
    };
    expect(await attempt.run(operation)).toMatchObject({ kind: "failure", uncertain: true });
    const changed = vi.fn(async () => {});
    expect(await attempt.run(changed)).toEqual({ kind: "needs-recovery" });
    expect(changed).not.toHaveBeenCalled();
    expect(await attempt.retry()).toEqual({ kind: "success" });
    expect(requests).toEqual([original, original]);
    expect(attempt.hasPending).toBe(false);
  });
  it("keeps an unknown operation pending when recovery is refused after revocation", async () => {
    const attempt = new SubmissionAttempt();
    let calls = 0;
    await attempt.run(async () => {
      if (++calls === 1) throw new TypeError("lost");
      throw new SubmissionRequestError("已撤权", undefined, 403);
    });
    expect(await attempt.retry()).toMatchObject({ kind: "failure", uncertain: true });
    expect(attempt.hasPending).toBe(true);
  });
  it.each([403, 409, 422])("unlocks a definitely rejected initial HTTP %i operation", async status => {
    const attempt = new SubmissionAttempt();
    expect(await attempt.run(async () => { throw new SubmissionRequestError("拒绝", undefined, status); }))
      .toMatchObject({ kind: "failure", uncertain: false });
    expect(await attempt.run(async () => {})).toEqual({ kind: "success" });
  });
  it("does not replay outside the server's retention window", async () => {
    let now = 0;
    const attempt = new SubmissionAttempt(() => now);
    const send = vi.fn(async () => { throw new TypeError("lost"); });
    await attempt.run(send);
    now = 23 * 60 * 60 * 1000;
    expect(await attempt.retry()).toEqual({ kind: "expired" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(attempt.hasPending).toBe(true);
  });
  it("clears pending before navigating and does not replay a post-success UI failure", async () => {
    const attempt = new SubmissionAttempt();
    expect(await attempt.run(async () => {
      attempt.markConfirmed();
      expect(attempt.hasPending).toBe(false);
      throw new Error("local rendering failed");
    })).toMatchObject({ kind: "failure", uncertain: false, confirmed: true });
  });
  it("treats an explicit cancellation as definite and silent", async () => {
    const attempt = new SubmissionAttempt();
    expect(await attempt.run(async () => { throw new SubmissionCancelled("取消"); }))
      .toMatchObject({ kind: "failure", uncertain: false, failure: { cancelled: true } });
    expect(attempt.hasPending).toBe(false);
  });
});
