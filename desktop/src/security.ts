import { app, shell, type Session, type WebContents } from "electron";
import { externalHttpsUrl, originOf } from "./urls.js";

export type PermissionPolicy = (contents: WebContents | null, permission: string, origin: string | null) => boolean;

const DENY_ALL: PermissionPolicy = () => false;

export function applyPermissionPolicy(target: Session, policy: PermissionPolicy = DENY_ALL): void {
  target.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(policy(contents, permission, originOf(details.requestingUrl)));
  });
  target.setPermissionCheckHandler((contents, permission, requestingOrigin) => policy(contents, permission, originOf(requestingOrigin)));
  target.setDevicePermissionHandler(() => false);
}

export function hardenApp(): void {
  app.on("select-client-certificate", (event, _contents, _url, _certificates, callback) => {
    event.preventDefault();
    callback();
  });
  app.on("session-created", (created) => applyPermissionPolicy(created));
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
  });
}

export function openExternalHttps(candidate: string): boolean {
  const target = externalHttpsUrl(candidate);
  if (target === null) {
    return false;
  }
  shell.openExternal(target).catch(() => undefined);
  return true;
}
