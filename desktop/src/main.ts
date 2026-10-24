import { app, Menu, nativeTheme, type MenuItemConstructorOptions } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopShell, type DesktopPaths } from "./desktop.js";
import { hardenApp } from "./security.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function desktopPaths(): DesktopPaths {
  return {
    pages: path.join(root, "pages"),
    assets: path.join(root, "assets"),
    preload: path.join(here, "preload.cjs"),
    userData: app.getPath("userData")
  };
}

function macMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }];
  return Menu.buildFromTemplate(template);
}

function run(): void {
  let current: DesktopShell | null = null;
  const open = (): void => {
    const shell = new DesktopShell(desktopPaths());
    current = shell;
    shell.start().catch((error: unknown) => {
      console.error(error);
      app.exit(1);
    });
  };
  hardenApp();
  app.on("second-instance", () => current?.focus());
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
  app.on("activate", () => {
    if (app.isReady() && (current === null || current.isClosed())) {
      open();
    }
  });
  app
    .whenReady()
    .then(() => {
      nativeTheme.themeSource = "dark";
      Menu.setApplicationMenu(process.platform === "darwin" ? macMenu() : null);
      open();
    })
    .catch((error: unknown) => {
      console.error(error);
      app.exit(1);
    });
}

if (process.platform === "win32") {
  app.setAppUserModelId("snypra-edge.desktop");
}

if (app.requestSingleInstanceLock()) {
  run();
} else {
  app.quit();
}
