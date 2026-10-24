import { FuseState, FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } from "@electron/fuses";
import { packager } from "@electron/packager";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function shipped(file) {
  if (file === "" || file === "/package.json" || file === "/build") {
    return true;
  }
  return file.startsWith("/build/") && !file.startsWith("/build/test");
}

const platform = option("platform", "win32");
const arch = option("arch", "x64");
const out = path.resolve(root, option("out", "out"));
const electronZipDir = option("electron-zip-dir", null);

const appPaths = await packager({
  dir: root,
  out,
  platform,
  arch,
  name: manifest.productName,
  executableName: manifest.productName,
  appVersion: manifest.version,
  asar: true,
  prune: true,
  overwrite: true,
  ignore: (file) => !shipped(file),
  ...(electronZipDir === null ? {} : { electronZipDir: path.resolve(electronZipDir) }),
  ...(platform === "win32"
    ? {
        icon: path.join(root, "assets", "icon.ico"),
        win32metadata: { CompanyName: manifest.productName, FileDescription: `${manifest.productName} desktop`, ProductName: manifest.productName }
      }
    : {})
});

const fuses = {
  version: FuseVersion.V1,
  resetAdHocDarwinSignature: platform === "darwin" && arch === "arm64",
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: true
};

function electronBinary(appPath) {
  if (platform === "darwin" || platform === "mas") {
    return path.join(appPath, `${manifest.productName}.app`);
  }
  return path.join(appPath, platform === "win32" ? `${manifest.productName}.exe` : manifest.productName);
}

async function lockFuses(binary) {
  await flipFuses(binary, fuses);
  const wire = await getCurrentFuseWire(binary);
  const wrong = Object.entries(fuses)
    .filter(([key]) => /^\d+$/.test(key))
    .filter(([key, wanted]) => wire[key] !== (wanted ? FuseState.ENABLE : FuseState.DISABLE))
    .map(([key]) => FuseV1Options[key]);
  if (wrong.length > 0) {
    throw new Error(`fuses not set on ${binary}: ${wrong.join(", ")}`);
  }
}

for (const appPath of appPaths) {
  await lockFuses(electronBinary(appPath));
  console.log(`packaged ${path.relative(root, appPath)} with hardened fuses`);
}
