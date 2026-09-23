import { describe, expect, it } from "vitest";
import { disputeWindowClosesAt, isDisputeWindowOpen } from "../sdk-js/src/index.js";

const r = (windowClosesAt: string | null | undefined) => ({ dispute: { windowClosesAt } });

describe("dispute-window helpers (SPEC v0.31)", () => {
  it("treat a draft's null, a missing value, and a legacy \"\" as no window, not 1970", () => {
    for (const v of [null, undefined, "", "not-a-date"]) {
      expect(disputeWindowClosesAt(r(v))).toBeNull();
      expect(isDisputeWindowOpen(r(v))).toBe(false);
    }
  });

  it("report a real window as open before it closes and closed after", () => {
    const closes = "2026-09-26T18:54:05.162Z";
    expect(disputeWindowClosesAt(r(closes))!.toISOString()).toBe(closes);
    expect(isDisputeWindowOpen(r(closes), Date.parse(closes) - 1)).toBe(true);
    expect(isDisputeWindowOpen(r(closes), Date.parse(closes))).toBe(false);
  });
});
