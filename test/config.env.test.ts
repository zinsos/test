import { describe, expect, it } from "vitest";
import { databaseSsl, loadEnv } from "../src/config/env.js";

describe("LIVE_DRY_RUN", () => {
  it("defaults to a dry run when absent, empty or blank", () => {
    for (const value of [undefined, "", " ", "\t"]) {
      const source = value === undefined ? { TRADING_MODE: "live" } : { TRADING_MODE: "live", LIVE_DRY_RUN: value };
      expect(loadEnv(source).LIVE_DRY_RUN).toBe(true);
    }
  });

  it("accepts explicit spellings with any case and surrounding spaces", () => {
    for (const value of ["true", "TRUE ", " 1", "yes", "On"]) {
      expect(loadEnv({ LIVE_DRY_RUN: value }).LIVE_DRY_RUN).toBe(true);
    }
    for (const value of ["false", " FALSE", "0", "no", "off "]) {
      expect(loadEnv({ LIVE_DRY_RUN: value }).LIVE_DRY_RUN).toBe(false);
    }
  });

  it("refuses to start on anything it does not recognise instead of sending real transactions", () => {
    for (const value of ["y", "enabled", "ture", "dry", "true # keep on", "flase"]) {
      expect(() => loadEnv({ TRADING_MODE: "live", LIVE_DRY_RUN: value })).toThrow(/LIVE_DRY_RUN/);
    }
  });
});

describe("DATABASE_SSL", () => {
  it("auto-detects when unset or blank and fails on unknown values", () => {
    expect(databaseSsl(loadEnv({ DATABASE_URL: "postgres://db.example.com/x", DATABASE_SSL: "" }))).toBe(true);
    expect(databaseSsl(loadEnv({ DATABASE_URL: "postgres://localhost/x" }))).toBe(false);
    expect(databaseSsl(loadEnv({ DATABASE_URL: "postgres://localhost/x", DATABASE_SSL: " on " }))).toBe(true);
    expect(databaseSsl(loadEnv({ DATABASE_URL: "postgres://db.example.com/x", DATABASE_SSL: "OFF" }))).toBe(false);
    expect(() => loadEnv({ DATABASE_SSL: "require" })).toThrow(/DATABASE_SSL/);
  });
});

describe("DASHBOARD_ALLOW_OPEN", () => {
  it("defaults to false and fails on unknown values", () => {
    expect(loadEnv({}).DASHBOARD_ALLOW_OPEN).toBe(false);
    expect(loadEnv({ DASHBOARD_ALLOW_OPEN: "" }).DASHBOARD_ALLOW_OPEN).toBe(false);
    expect(loadEnv({ DASHBOARD_ALLOW_OPEN: " Yes " }).DASHBOARD_ALLOW_OPEN).toBe(true);
    expect(() => loadEnv({ DASHBOARD_ALLOW_OPEN: "open" })).toThrow(/DASHBOARD_ALLOW_OPEN/);
  });

  it("treats blank values from env files as unset", () => {
    const env = loadEnv({ RPC_HTTP_URL: "", RPC_WS_URL: "  ", HOST: "", LIVE_DRY_RUN: "", DASHBOARD_TOKEN: "" });
    expect(env.RPC_HTTP_URL).toBeUndefined();
    expect(env.RPC_WS_URL).toBeUndefined();
    expect(env.HOST).toBeUndefined();
    expect(env.DASHBOARD_TOKEN).toBeUndefined();
    expect(env.LIVE_DRY_RUN).toBe(true);
  });
});
