export const CHANNEL_ACTION = "snypra:action";
export const CHANNEL_GET_STATUS = "snypra:get-status";
export const CHANNEL_GET_SETUP = "snypra:get-setup";
export const CHANNEL_SAVE_SETUP = "snypra:save-setup";
export const CHANNEL_STATUS = "snypra:status";

export const TOOLBAR_ACTIONS = ["open-web", "reload", "settings"] as const;
export const PAGE_ACTIONS = ["retry", "change-url", "cancel-setup"] as const;

export type ToolbarAction = (typeof TOOLBAR_ACTIONS)[number];
export type PageAction = (typeof PAGE_ACTIONS)[number];

export type ViewMode = "setup" | "dashboard" | "error";
export type ConnectionState = "setup" | "loading" | "online" | "degraded" | "offline";
export type TokenStorage = "encrypted" | "plain" | "none";

export interface ToolbarStatus {
  state: ConnectionState;
  label: string;
  detail: string;
  host: string | null;
  canOpenWeb: boolean;
  canReload: boolean;
  view: ViewMode;
}

export interface SetupInfo {
  origin: string | null;
  hasToken: boolean;
  tokenStorage: TokenStorage;
  canCancel: boolean;
  note: string | null;
}

export type SaveResult = { ok: true; warning: string | null } | { ok: false; field: "url" | "token"; message: string };

export function isToolbarAction(value: unknown): value is ToolbarAction {
  return typeof value === "string" && (TOOLBAR_ACTIONS as readonly string[]).includes(value);
}

export function isPageAction(value: unknown): value is PageAction {
  return typeof value === "string" && (PAGE_ACTIONS as readonly string[]).includes(value);
}
