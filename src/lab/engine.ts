import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPLAY_ENGINE_DIRS: readonly string[] = [
  "backtest",
  "chain",
  "config",
  "core",
  "db",
  "execution",
  "exits",
  "market",
  "risk",
  "scorer",
  "tracker",
  "trader"
];
export const ENGINE_VERSION_LENGTH = 16;

let cached: string | null = null;

function moduleFile(): string {
  return fileURLToPath(import.meta.url);
}

function sourceRoot(): string {
  return path.resolve(path.dirname(moduleFile()), "..");
}

function moduleExtension(): string {
  return path.extname(moduleFile());
}

function listFiles(directory: string, extension: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(directory).sort()) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listFiles(full, extension));
    } else if (entry.endsWith(extension) && !entry.endsWith(`.d${extension}`)) {
      files.push(full);
    }
  }
  return files;
}

export function computeEngineVersion(root: string = sourceRoot(), extension: string = moduleExtension(), dirs: readonly string[] = REPLAY_ENGINE_DIRS): string {
  const hash = createHash("sha256");
  for (const dir of [...dirs].sort()) {
    for (const file of listFiles(path.join(root, dir), extension)) {
      hash.update(path.relative(root, file).split(path.sep).join("/"), "utf8");
      hash.update("\u0000");
      hash.update(readFileSync(file));
      hash.update("\u0000");
    }
  }
  return hash.digest("hex").slice(0, ENGINE_VERSION_LENGTH);
}

export function replayEngineVersion(): string {
  cached ??= computeEngineVersion();
  return cached;
}
