import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HttpError } from "../src/analytics/http.js";
import { createRpcKeyControls, heliusKeyOf, heliusUrls, withEnvValues } from "../src/app/rpcKey.js";

const OLD_KEY = "11111111-2222-3333-4444-555555555555";
const NEW_KEY = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function envFileWith(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rpc-key-"));
  dirs.push(dir);
  const file = join(dir, ".env");
  await writeFile(file, text, { mode: 0o600 });
  return file;
}

const OLD_ENV = [`DATABASE_URL=postgres://x`, `RPC_HTTP_URL=${heliusUrls(OLD_KEY).http}`, `RPC_WS_URL=${heliusUrls(OLD_KEY).ws}`, "RPC_MAX_RPS=0.3", ""].join("\n");

describe("env file rewriting", () => {
  it("replaces every matching line, keeps the rest and appends missing names", () => {
    const text = "A=1\nRPC_HTTP_URL=old\nB=2\nRPC_HTTP_URL=older\n\n";
    expect(withEnvValues(text, { RPC_HTTP_URL: "new", RPC_WS_URL: "ws" })).toBe("A=1\nRPC_HTTP_URL=new\nB=2\nRPC_HTTP_URL=new\nRPC_WS_URL=ws\n");
  });

  it("reads keys only from Helius hosts", () => {
    expect(heliusKeyOf(heliusUrls(OLD_KEY).http)).toBe(OLD_KEY);
    expect(heliusKeyOf(heliusUrls(OLD_KEY).ws)).toBe(OLD_KEY);
    expect(heliusKeyOf(`https://helius-rpc.com.example.org/?api-key=${OLD_KEY}`)).toBeNull();
    expect(heliusKeyOf(`https://rpc.example.org/?api-key=${OLD_KEY}`)).toBeNull();
    expect(heliusKeyOf("https://mainnet.helius-rpc.com/?api-key=not-a-key")).toBeNull();
    expect(heliusKeyOf(undefined)).toBeNull();
  });
});

describe("rpc key controls", () => {
  it("checks the key, rewrites both urls, keeps the previous file and restarts", async () => {
    const file = await envFileWith(OLD_ENV);
    const probed: string[] = [];
    let restarts = 0;
    const controls = createRpcKeyControls({
      envFile: file,
      currentHttpUrl: heliusUrls(OLD_KEY).http,
      probe: (url) => {
        probed.push(url);
        return Promise.resolve();
      },
      restart: () => {
        restarts += 1;
      }
    });
    expect(controls.status()).toEqual({ provider: "helius", keyHint: "1111…5555", canChange: true });
    expect(await controls.change(NEW_KEY)).toEqual({ ok: true, keyHint: "aaaa…eeee", restarting: true });
    expect(probed).toEqual([heliusUrls(NEW_KEY).http]);
    expect(restarts).toBe(1);
    const written = await readFile(file, "utf8");
    expect(written).toContain(`RPC_HTTP_URL=${heliusUrls(NEW_KEY).http}\n`);
    expect(written).toContain(`RPC_WS_URL=${heliusUrls(NEW_KEY).ws}\n`);
    expect(written).toContain("RPC_MAX_RPS=0.3\n");
    expect(written).not.toContain(OLD_KEY);
    expect(await readFile(`${file}.previous`, "utf8")).toBe(OLD_ENV);
    expect(controls.status().keyHint).toBe("aaaa…eeee");
  });

  it("leaves the file alone when the key is malformed or Helius rejects it", async () => {
    const file = await envFileWith(OLD_ENV);
    let restarts = 0;
    const controls = createRpcKeyControls({
      envFile: file,
      currentHttpUrl: heliusUrls(OLD_KEY).http,
      probe: () => Promise.reject(new HttpError(422, "key_rejected", "Helius rejected this key")),
      restart: () => {
        restarts += 1;
      }
    });
    await expect(controls.change(`${NEW_KEY}\nLIVE_DRY_RUN=false`)).rejects.toMatchObject({ status: 400 });
    await expect(controls.change(NEW_KEY)).rejects.toMatchObject({ status: 422 });
    expect(await readFile(file, "utf8")).toBe(OLD_ENV);
    expect(restarts).toBe(0);
  });

  it("is off without an env file", async () => {
    const controls = createRpcKeyControls({ envFile: null, currentHttpUrl: "https://rpc.example.org", restart: () => undefined });
    expect(controls.status()).toEqual({ provider: "custom", keyHint: null, canChange: false });
    await expect(controls.change(NEW_KEY)).rejects.toMatchObject({ status: 409 });
  });
});
