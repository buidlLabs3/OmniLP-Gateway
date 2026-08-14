import { describe, expect, it } from "vitest";

import { getFailedState } from "./jobs.js";

describe("verification failures", () => {
  it("keeps each transaction kind in its own recovery state", () => {
    expect(getFailedState("source")).toBe("source_rejected");
    expect(getFailedState("deposit")).toBe("deposit_failed");
    expect(getFailedState("withdraw")).toBe("withdraw_failed");
    expect(getFailedState("exit")).toBe("exit_failed");
  });
});
