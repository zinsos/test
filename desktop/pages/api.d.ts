type ConnectionState = "setup" | "loading" | "online" | "degraded" | "offline";

interface ToolbarStatus {
  state: ConnectionState;
  label: string;
  detail: string;
  host: string | null;
  canOpenWeb: boolean;
  canReload: boolean;
  view: "setup" | "dashboard" | "error";
}

interface SetupInfo {
  origin: string | null;
  hasToken: boolean;
  tokenStorage: "encrypted" | "plain" | "none";
  canCancel: boolean;
  note: string | null;
}

type SaveResult = { ok: true; warning: string | null } | { ok: false; field: "url" | "token"; message: string };

interface SnypraBridge {
  action(name: "open-web" | "reload" | "settings" | "retry" | "change-url" | "cancel-setup"): void;
  getStatus(): Promise<ToolbarStatus>;
  getSetup(): Promise<SetupInfo>;
  saveSetup(url: string, token: string): Promise<SaveResult>;
  onStatus(listener: (status: ToolbarStatus) => void): void;
}

interface Window {
  snypra: SnypraBridge;
}
