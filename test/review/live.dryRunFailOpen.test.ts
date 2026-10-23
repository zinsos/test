import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";

describe("review live: LIVE_DRY_RUN fails open on values it does not recognise", () => {
  it.each(["", " ", "TRUE ", "y", "enabled", "ture", "dry"])("keeps the dry run on for LIVE_DRY_RUN=%j", (value) => {
    let dryRun: boolean | null = null;
    try {
      dryRun = loadEnv({ TRADING_MODE: "live", LIVE_DRY_RUN: value }).LIVE_DRY_RUN;
    } catch {
      dryRun = true;
    }
    expect(dryRun).toBe(true);
  });

  it("turns the dry run off only for an explicit false", () => {
    expect(loadEnv({ TRADING_MODE: "live", LIVE_DRY_RUN: "false" }).LIVE_DRY_RUN).toBe(false);
    expect(loadEnv({ TRADING_MODE: "live" }).LIVE_DRY_RUN).toBe(true);
  });
});
