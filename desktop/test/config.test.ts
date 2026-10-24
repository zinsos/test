import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { loadConfig, saveConfig, type TokenCodec } from "../src/config.js";
import { placeWindow, parseWindowState } from "../src/windowState.js";

const directory = mkdtempSync(path.join(tmpdir(), "snypra-desktop-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const reversing: TokenCodec = {
  encrypt: async (token) => ({ scheme: "safeStorage", value: Buffer.from([...token].reverse().join("")).toString("base64") }),
  decrypt: async (stored) => ({
    token: stored.scheme === "plain" ? stored.value : [...Buffer.from(stored.value, "base64").toString()].reverse().join(""),
    stale: false
  })
};

describe("config", () => {
  it("round-trips without writing the token in clear text", async () => {
    const file = path.join(directory, "config.json");
    const scheme = await saveConfig(file, { origin: "https://alpha.example.com", token: "test-token-0123456789" }, reversing);
    assert.equal(scheme, "safeStorage");
    assert.ok(!readFileSync(file, "utf8").includes("test-token"));
    assert.deepEqual(await loadConfig(file, reversing), {
      status: "ok",
      config: { origin: "https://alpha.example.com", token: "test-token-0123456789" },
      tokenScheme: "safeStorage",
      stale: false
    });
    if (process.platform !== "win32") {
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
  });

  it("reports missing, invalid and undecryptable files", async () => {
    assert.deepEqual(await loadConfig(path.join(directory, "absent.json"), reversing), { status: "missing" });
    const bad = path.join(directory, "bad.json");
    writeFileSync(bad, "{not json");
    assert.deepEqual(await loadConfig(bad, reversing), { status: "invalid" });
    writeFileSync(bad, JSON.stringify({ version: 1, origin: "http://evil.example.com", token: null }));
    assert.deepEqual(await loadConfig(bad, reversing), { status: "invalid" });
    const locked = path.join(directory, "locked.json");
    writeFileSync(locked, JSON.stringify({ version: 1, origin: "https://alpha.example.com", token: { scheme: "safeStorage", value: "AAAA" } }));
    assert.deepEqual(await loadConfig(locked, { ...reversing, decrypt: async () => null }), { status: "token_unreadable", origin: "https://alpha.example.com" });
  });
});

describe("window state", () => {
  const screenArea = { x: 0, y: 0, width: 1920, height: 1040 };
  const preferred = { width: 1280, height: 860 };
  const minimum = { width: 420, height: 400 };

  it("restores a visible window and clamps its size", () => {
    const state = parseWindowState(JSON.stringify({ bounds: { x: 100, y: 80, width: 300, height: 5000 }, maximized: true }));
    assert.deepEqual(placeWindow(state, [screenArea], preferred, minimum), { x: 100, y: 80, width: 420, height: 1040, maximized: true });
  });

  it("drops a position that is off every screen", () => {
    const state = parseWindowState(JSON.stringify({ bounds: { x: 4000, y: 80, width: 900, height: 700 }, maximized: false }));
    assert.deepEqual(placeWindow(state, [screenArea], preferred, minimum), { width: 900, height: 700, maximized: false });
  });

  it("falls back to defaults for garbage", () => {
    assert.deepEqual(placeWindow(parseWindowState("nope"), [screenArea], preferred, minimum), { width: 1280, height: 860, maximized: false });
  });
});
