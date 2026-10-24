import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "build");
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const staticPages = /\.(html|css)$/;

function compile(project) {
  const result = spawnSync(process.execPath, [tsc, "-p", path.join(root, project)], { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

rmSync(out, { recursive: true, force: true });
compile("tsconfig.json");
compile("tsconfig.pages.json");
mkdirSync(path.join(out, "pages"), { recursive: true });
for (const name of readdirSync(path.join(root, "pages"))) {
  if (staticPages.test(name)) {
    cpSync(path.join(root, "pages", name), path.join(out, "pages", name));
  }
}
if (!existsSync(path.join(root, "assets", "icon.png"))) {
  console.error("assets/icon.png is missing: run npm run icon");
  process.exit(1);
}
cpSync(path.join(root, "assets"), path.join(out, "assets"), { recursive: true });
