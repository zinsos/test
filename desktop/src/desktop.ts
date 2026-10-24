import {
  app,
  BaseWindow,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  screen,
  session,
  WebContentsView,
  type ContextMenuParams,
  type Input,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents,
  type WebPreferences
} from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, type DesktopConfig, type TokenCodec, type TokenScheme } from "./config.js";
import {
  CHANNEL_ACTION,
  CHANNEL_GET_SETUP,
  CHANNEL_GET_STATUS,
  CHANNEL_SAVE_SETUP,
  CHANNEL_STATUS,
  isPageAction,
  isToolbarAction,
  type PageAction,
  type SaveResult,
  type SetupInfo,
  type ToolbarAction,
  type ToolbarStatus,
  type ViewMode
} from "./ipcTypes.js";
import { checkHealth, classifyHttpStatus, classifyNetworkError, probeDashboard, type HealthResult, type ProbeFetch } from "./probe.js";
import { applyPermissionPolicy, openExternalHttps } from "./security.js";
import {
  dashboardHomeUrl,
  hostLabel,
  isBlobOfOrigin,
  isSameOrigin,
  isValidToken,
  MAX_TOKEN_LENGTH,
  MAX_URL_LENGTH,
  parseDashboardUrl,
  requestOriginOf,
  webVersionUrl,
  withDashboardAuthorization
} from "./urls.js";
import { placeWindow, readWindowState, writeWindowState } from "./windowState.js";

export interface DesktopPaths {
  pages: string;
  assets: string;
  preload: string;
  userData: string;
}

interface Failure {
  code: string;
  message: string;
}

const TOOLBAR_HEIGHT = 44;
const MIN_SIZE = { width: 420, height: 400 };
const PREFERRED_SIZE = { width: 1280, height: 860 };
const PROBE_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 8_000;
const HEALTH_INTERVAL_MS = 30_000;
const SAVE_STATE_DELAY_MS = 800;
const OPEN_AFTER_SAVE_MS = 700;
const SHOW_FALLBACK_MS = 2_500;
const ZOOM_STEP = 0.5;
const ERR_ABORTED = -3;
const PAGE_BACKGROUND = "#090909";
const DASHBOARD_PARTITION = "persist:dashboard";
const LOCAL_PARTITION = "snypra-local";
const PROBE_PARTITION = "snypra-probe";
const CLIPBOARD_WRITE = "clipboard-sanitized-write";

const ERROR_TITLES: Record<string, string> = {
  tunnel_gone: "Tunnel address changed",
  unreachable: "Dashboard unreachable",
  refused: "Server not running",
  offline: "You are offline",
  timeout: "No answer from the server",
  tls: "Certificate problem",
  server_error: "Server not answering",
  not_dashboard: "Not a snypra-edge dashboard",
  crashed: "Dashboard stopped"
};

async function encryptionIsReal(): Promise<boolean> {
  try {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      return false;
    }
    return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text";
  } catch {
    return false;
  }
}

const tokenCodec: TokenCodec = {
  async encrypt(token) {
    if (!(await encryptionIsReal())) {
      return { scheme: "plain", value: token };
    }
    return { scheme: "safeStorage", value: (await safeStorage.encryptStringAsync(token)).toString("base64") };
  },
  async decrypt(stored) {
    if (stored.scheme === "plain") {
      return { token: stored.value, stale: false };
    }
    try {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) {
        return null;
      }
      const decrypted = await safeStorage.decryptStringAsync(Buffer.from(stored.value, "base64"));
      return { token: decrypted.result, stale: decrypted.shouldReEncrypt };
    } catch {
      return null;
    }
  }
};

function pageNameOf(frameUrl: string, pagesDir: string): string | null {
  let file: string;
  try {
    const url = new URL(frameUrl);
    if (url.protocol !== "file:") {
      return null;
    }
    file = fileURLToPath(url);
  } catch {
    return null;
  }
  const relative = path.relative(pagesDir, file);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) {
    return null;
  }
  return relative.toLowerCase();
}

function windowIcon(assets: string): Electron.NativeImage {
  return nativeImage.createFromPath(path.join(assets, process.platform === "win32" ? "icon.ico" : "icon.png"));
}

export class DesktopShell {
  private readonly window: BaseWindow;
  private readonly toolbar: WebContentsView;
  private readonly local: WebContentsView;
  private readonly dashboard: WebContentsView;
  private readonly probeSession: Session;
  private readonly configFile: string;
  private readonly stateFile: string;
  private readonly fetcher: ProbeFetch;
  private readonly healthTimer: NodeJS.Timeout;
  private config: DesktopConfig | null = null;
  private tokenScheme: TokenScheme | null = null;
  private encryptionAvailable = false;
  private unreadableOrigin: string | null = null;
  private configNote: string | null = null;
  private mode: ViewMode = "setup";
  private dashboardReady = false;
  private health: HealthResult | null = null;
  private healthBusy = false;
  private saving = false;
  private failure: Failure | null = null;
  private saveStateTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly maximizeOnShow: boolean;

  constructor(private readonly paths: DesktopPaths) {
    this.configFile = path.join(paths.userData, "config.json");
    this.stateFile = path.join(paths.userData, "window-state.json");
    this.probeSession = session.fromPartition(PROBE_PARTITION);
    this.fetcher = (url, init) =>
      this.probeSession.fetch(url, { headers: init.headers, signal: init.signal, redirect: "error", cache: "no-store", credentials: "omit" });
    const placement = placeWindow(
      readWindowState(this.stateFile),
      screen.getAllDisplays().map((display) => display.workArea),
      PREFERRED_SIZE,
      MIN_SIZE
    );
    this.maximizeOnShow = placement.maximized;
    this.window = new BaseWindow({
      title: "snypra-edge",
      width: placement.width,
      height: placement.height,
      ...(placement.x !== undefined && placement.y !== undefined ? { x: placement.x, y: placement.y } : {}),
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      show: false,
      backgroundColor: PAGE_BACKGROUND,
      icon: windowIcon(paths.assets),
      autoHideMenuBar: true
    });
    this.toolbar = new WebContentsView({ webPreferences: this.localPreferences() });
    this.local = new WebContentsView({ webPreferences: this.localPreferences() });
    this.dashboard = new WebContentsView({ webPreferences: this.dashboardPreferences() });
    for (const view of [this.dashboard, this.local, this.toolbar]) {
      view.setBackgroundColor(PAGE_BACKGROUND);
      this.window.contentView.addChildView(view);
    }
    this.secureLocal(this.toolbar.webContents);
    this.secureLocal(this.local.webContents);
    this.secureDashboard();
    this.watchDashboard();
    this.registerIpc();
    this.watchWindow();
    this.healthTimer = setInterval(() => {
      if (this.window.isVisible() && !this.window.isMinimized()) {
        void this.refreshHealth();
      }
    }, HEALTH_INTERVAL_MS);
    this.layout();
  }

  async start(): Promise<void> {
    this.encryptionAvailable = await encryptionIsReal();
    const loaded = await loadConfig(this.configFile, tokenCodec);
    if (loaded.status === "ok") {
      this.config = loaded.config;
      this.tokenScheme = loaded.tokenScheme;
      if (loaded.stale || (loaded.tokenScheme === "plain" && this.encryptionAvailable)) {
        await this.persist(loaded.config).catch(() => undefined);
      }
    } else if (loaded.status === "token_unreadable") {
      this.unreadableOrigin = loaded.origin;
      this.configNote = "The saved token could not be decrypted on this computer. Enter it again.";
    } else if (loaded.status === "invalid") {
      this.configNote = "The saved settings were unreadable. Enter them again.";
    }
    if (this.closed) {
      return;
    }
    const showTimer = setTimeout(() => this.reveal(), SHOW_FALLBACK_MS);
    this.toolbar.webContents.once("did-finish-load", () => {
      clearTimeout(showTimer);
      this.reveal();
    });
    this.toolbar.webContents.loadFile(path.join(this.paths.pages, "toolbar.html")).catch(() => undefined);
    if (this.config === null) {
      this.showSetup();
    } else {
      this.loadDashboard();
    }
  }

  focus(): void {
    if (this.closed) {
      return;
    }
    if (this.window.isMinimized()) {
      this.window.restore();
    }
    this.window.show();
    this.window.focus();
  }

  isClosed(): boolean {
    return this.closed;
  }

  private reveal(): void {
    if (this.closed || this.window.isVisible()) {
      return;
    }
    if (this.maximizeOnShow) {
      this.window.maximize();
    }
    this.window.show();
    this.visibleContents().focus();
  }

  private localPreferences(): WebPreferences {
    return {
      preload: this.paths.preload,
      partition: LOCAL_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      safeDialogs: true,
      devTools: !app.isPackaged
    };
  }

  private dashboardPreferences(): WebPreferences {
    return {
      partition: DASHBOARD_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      safeDialogs: true,
      devTools: !app.isPackaged
    };
  }

  private secureLocal(contents: WebContents): void {
    contents.on("will-frame-navigate", (event) => event.preventDefault());
    contents.on("will-redirect", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("before-input-event", (event, input) => this.onInput(contents, event, input));
    contents.on("context-menu", (_event, params) => this.showContextMenu(contents, params));
    const localSession = contents.session;
    if (localSession.listenerCount("will-download") === 0) {
      localSession.on("will-download", (event) => event.preventDefault());
      localSession.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: !(pageNameOf(details.url, this.paths.pages) !== null || details.url.startsWith("devtools:")) });
      });
    }
  }

  private secureDashboard(): void {
    const contents = this.dashboard.webContents;
    const dashboardSession = contents.session;
    applyPermissionPolicy(
      dashboardSession,
      (requester, permission, origin) =>
        requester === contents && permission === CLIPBOARD_WRITE && this.config !== null && origin === this.config.origin
    );
    dashboardSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !this.isDashboardRequestAllowed(details.url) });
    });
    dashboardSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const config = this.config;
      callback({
        requestHeaders: config === null ? details.requestHeaders : withDashboardAuthorization(details.url, details.requestHeaders, config.origin, config.token)
      });
    });
    dashboardSession.webRequest.onCompleted((details) => {
      if (details.statusCode === 401) {
        this.onDashboardUnauthorized(details.url);
      }
    });
    dashboardSession.on("will-download", (event, item, requester) => {
      const origin = this.config?.origin ?? null;
      const url = item.getURL();
      if (requester !== contents || origin === null || !(isBlobOfOrigin(url, origin) || isSameOrigin(url, origin))) {
        event.preventDefault();
      }
    });
    contents.setWindowOpenHandler(({ url }) => {
      openExternalHttps(url);
      return { action: "deny" };
    });
    contents.on("will-frame-navigate", (event) => {
      if (this.config !== null && isSameOrigin(event.url, this.config.origin)) {
        return;
      }
      event.preventDefault();
      if (event.isMainFrame) {
        openExternalHttps(event.url);
      }
    });
    contents.on("will-redirect", (event) => {
      if (this.config === null || !isSameOrigin(event.url, this.config.origin)) {
        event.preventDefault();
      }
    });
    contents.on("before-input-event", (event, input) => this.onInput(contents, event, input));
    contents.on("context-menu", (_event, params) => this.showContextMenu(contents, params));
  }

  private isDashboardRequestAllowed(url: string): boolean {
    if (url.startsWith("blob:") || url.startsWith("data:") || url.startsWith("devtools:")) {
      return true;
    }
    return this.config !== null && requestOriginOf(url) === this.config.origin;
  }

  private onDashboardUnauthorized(url: string): void {
    const config = this.config;
    if (config === null || this.mode !== "dashboard" || requestOriginOf(url) !== config.origin) {
      return;
    }
    this.configNote =
      config.token === null
        ? "This dashboard needs a token. Paste the dashboard token and test again."
        : "The server rejected the saved token. Paste the current dashboard token and test again.";
    this.dashboardReady = false;
    this.showSetup();
  }

  private watchDashboard(): void {
    const contents = this.dashboard.webContents;
    contents.on("did-navigate", (_event, _url, httpResponseCode) => {
      if (this.mode !== "dashboard" || this.config === null || httpResponseCode < 400) {
        return;
      }
      const failure = classifyHttpStatus(this.config.origin, httpResponseCode);
      this.showError(failure.code, failure.message);
    });
    contents.on("did-finish-load", () => {
      if (this.mode !== "dashboard" || this.config === null || !isSameOrigin(contents.getURL(), this.config.origin)) {
        return;
      }
      this.dashboardReady = true;
      this.pushStatus();
      void this.refreshHealth();
    });
    contents.on("did-fail-load", (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === ERR_ABORTED || this.mode !== "dashboard" || this.config === null) {
        return;
      }
      const failure = classifyNetworkError(new Error(errorDescription), this.config.origin, false, 0);
      this.showError(failure.code, failure.message);
    });
    contents.on("render-process-gone", (_event, details) => {
      this.dashboardReady = false;
      if (this.mode === "dashboard" && details.reason !== "clean-exit") {
        this.showError("crashed", "The dashboard page stopped unexpectedly. Try again to reload it.");
      }
    });
  }

  private watchWindow(): void {
    const relayout = (): void => this.layout();
    const persist = (): void => this.scheduleStateSave();
    this.window.on("resize", relayout);
    this.window.on("maximize", relayout);
    this.window.on("unmaximize", relayout);
    this.window.on("restore", relayout);
    this.window.on("enter-full-screen", relayout);
    this.window.on("leave-full-screen", relayout);
    this.window.on("resize", persist);
    this.window.on("move", persist);
    this.window.on("close", () => this.saveState());
    this.window.on("closed", () => this.dispose());
  }

  private layout(): void {
    if (this.closed) {
      return;
    }
    const { width, height } = this.window.getContentBounds();
    this.toolbar.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT });
    const body = { x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) };
    this.dashboard.setBounds(body);
    this.local.setBounds(body);
  }

  private scheduleStateSave(): void {
    if (this.saveStateTimer !== null) {
      clearTimeout(this.saveStateTimer);
    }
    this.saveStateTimer = setTimeout(() => this.saveState(), SAVE_STATE_DELAY_MS);
  }

  private saveState(): void {
    if (this.saveStateTimer !== null) {
      clearTimeout(this.saveStateTimer);
      this.saveStateTimer = null;
    }
    if (this.closed || this.window.isDestroyed() || this.window.isMinimized() || this.window.isFullScreen()) {
      return;
    }
    try {
      writeWindowState(this.stateFile, { bounds: this.window.getNormalBounds(), maximized: this.window.isMaximized() });
    } catch {
      return;
    }
  }

  private dispose(): void {
    this.closed = true;
    clearInterval(this.healthTimer);
    if (this.saveStateTimer !== null) {
      clearTimeout(this.saveStateTimer);
    }
    ipcMain.removeAllListeners(CHANNEL_ACTION);
    ipcMain.removeHandler(CHANNEL_GET_STATUS);
    ipcMain.removeHandler(CHANNEL_GET_SETUP);
    ipcMain.removeHandler(CHANNEL_SAVE_SETUP);
    for (const view of [this.toolbar, this.local, this.dashboard]) {
      if (!view.webContents.isDestroyed()) {
        view.webContents.close();
      }
    }
  }

  private visibleContents(): WebContents {
    return this.mode === "dashboard" ? this.dashboard.webContents : this.local.webContents;
  }

  private showBody(which: "dashboard" | "local"): void {
    this.dashboard.setVisible(which === "dashboard");
    this.local.setVisible(which === "local");
    if (this.window.isFocused()) {
      this.visibleContents().focus();
    }
  }

  private loadLocal(page: "setup.html" | "error.html", query?: Record<string, string>): void {
    this.local.webContents.loadFile(path.join(this.paths.pages, page), query ? { query } : {}).catch(() => undefined);
  }

  private loadDashboard(): void {
    const config = this.config;
    if (config === null) {
      this.showSetup();
      return;
    }
    this.mode = "dashboard";
    this.dashboardReady = false;
    this.health = null;
    this.failure = null;
    this.configNote = null;
    this.showBody("dashboard");
    this.dashboard.webContents.loadURL(dashboardHomeUrl(config.origin)).catch(() => undefined);
    this.pushStatus();
  }

  private showSetup(): void {
    if (this.mode === "setup" && pageNameOf(this.local.webContents.getURL(), this.paths.pages) === "setup.html") {
      return;
    }
    this.mode = "setup";
    this.loadLocal("setup.html");
    this.showBody("local");
    this.pushStatus();
  }

  private cancelSetup(): void {
    if (this.config === null || this.mode !== "setup") {
      return;
    }
    if (this.dashboardReady && isSameOrigin(this.dashboard.webContents.getURL(), this.config.origin)) {
      this.mode = "dashboard";
      this.showBody("dashboard");
      this.pushStatus();
      void this.refreshHealth();
      return;
    }
    this.loadDashboard();
  }

  private showError(code: string, message: string): void {
    this.mode = "error";
    this.dashboardReady = false;
    this.health = null;
    this.failure = { code, message };
    this.loadLocal("error.html", {
      code,
      title: ERROR_TITLES[code] ?? "Dashboard unavailable",
      message,
      host: this.config === null ? "" : hostLabel(this.config.origin)
    });
    this.showBody("local");
    this.pushStatus();
  }

  private reload(): void {
    if (this.mode === "setup") {
      return;
    }
    const config = this.config;
    if (this.mode === "dashboard" && this.dashboardReady && config !== null && isSameOrigin(this.dashboard.webContents.getURL(), config.origin)) {
      this.dashboardReady = false;
      this.health = null;
      this.dashboard.webContents.reload();
      this.pushStatus();
      return;
    }
    this.loadDashboard();
  }

  private openWebVersion(): void {
    const target = this.config === null ? null : webVersionUrl(this.config.origin);
    if (target !== null) {
      openExternalHttps(target);
    }
  }

  private status(): ToolbarStatus {
    const host = this.config === null ? null : hostLabel(this.config.origin);
    const base = { host, canOpenWeb: this.config !== null && webVersionUrl(this.config.origin) !== null, view: this.mode };
    if (this.mode === "setup") {
      return this.config === null
        ? { ...base, state: "setup", label: "Not set up", detail: "Enter the dashboard address and token", canReload: false }
        : { ...base, state: "setup", label: "Settings", detail: "Change the dashboard address or token", canReload: false };
    }
    if (this.mode === "error") {
      return { ...base, state: "offline", label: "Offline", detail: this.failure?.message ?? "The dashboard did not load", canReload: true };
    }
    if (!this.dashboardReady) {
      return { ...base, state: "loading", label: "Connecting", detail: `Loading ${host ?? "the dashboard"}`, canReload: true };
    }
    if (this.health === null || this.health.state === "online") {
      return { ...base, state: "online", label: "Online", detail: this.health?.message ?? "Dashboard loaded", canReload: true };
    }
    if (this.health.state === "degraded") {
      return { ...base, state: "degraded", label: "Degraded", detail: this.health.message, canReload: true };
    }
    return { ...base, state: "offline", label: "Unreachable", detail: this.health.message, canReload: true };
  }

  private pushStatus(): void {
    if (!this.closed && !this.toolbar.webContents.isDestroyed()) {
      this.toolbar.webContents.send(CHANNEL_STATUS, this.status());
    }
  }

  private async refreshHealth(): Promise<void> {
    const config = this.config;
    if (config === null || this.mode !== "dashboard" || !this.dashboardReady || this.healthBusy) {
      return;
    }
    this.healthBusy = true;
    try {
      const result = await checkHealth(this.fetcher, config.origin, HEALTH_TIMEOUT_MS);
      if (this.config === config && this.mode === "dashboard" && this.dashboardReady) {
        this.health = result;
        this.pushStatus();
      }
    } finally {
      this.healthBusy = false;
    }
  }

  private async persist(config: DesktopConfig): Promise<void> {
    this.tokenScheme = await saveConfig(this.configFile, config, tokenCodec);
  }

  private setupInfo(): SetupInfo {
    const hasToken = this.config !== null && this.config.token !== null;
    return {
      origin: this.config?.origin ?? this.unreadableOrigin,
      hasToken,
      tokenStorage: (hasToken ? this.tokenScheme === "safeStorage" : this.encryptionAvailable) ? "encrypted" : "plain",
      canCancel: this.config !== null,
      note: this.configNote
    };
  }

  private async saveSetup(rawUrl: string, rawToken: string): Promise<SaveResult> {
    if (this.saving) {
      return { ok: false, field: "url", message: "A test is already running." };
    }
    const parsed = parseDashboardUrl(rawUrl);
    if (!parsed.ok) {
      return { ok: false, field: "url", message: parsed.error };
    }
    const typed = rawToken.trim();
    const token = typed.length > 0 ? typed : (parsed.tokenFromUrl ?? this.config?.token ?? null);
    if (token !== null && !isValidToken(token)) {
      return { ok: false, field: "token", message: "The token contains spaces or unusual characters. Paste it again." };
    }
    this.saving = true;
    try {
      const result = await probeDashboard(this.fetcher, parsed.origin, token, PROBE_TIMEOUT_MS);
      if (!result.ok) {
        return { ok: false, field: result.field, message: result.message };
      }
      const next: DesktopConfig = { origin: parsed.origin, token };
      try {
        await this.persist(next);
      } catch {
        return { ok: false, field: "url", message: "The connection works, but the settings could not be saved on this computer." };
      }
      this.config = next;
      this.unreadableOrigin = null;
      this.configNote = null;
      this.dashboardReady = false;
      setTimeout(() => {
        if (!this.closed && this.mode === "setup") {
          this.loadDashboard();
        }
      }, OPEN_AFTER_SAVE_MS);
      return { ok: true, warning: result.warning };
    } finally {
      this.saving = false;
    }
  }

  private toolbarAction(action: ToolbarAction): void {
    if (action === "open-web") {
      this.openWebVersion();
    } else if (action === "reload") {
      this.reload();
    } else if (this.mode === "setup") {
      this.cancelSetup();
    } else {
      this.showSetup();
    }
  }

  private pageAction(action: PageAction, page: string): void {
    if (action === "retry" && page === "error.html") {
      this.loadDashboard();
    } else if (action === "change-url" && page === "error.html") {
      this.showSetup();
    } else if (action === "cancel-setup" && page === "setup.html") {
      this.cancelSetup();
    }
  }

  private senderPage(event: IpcMainEvent | IpcMainInvokeEvent, view: WebContentsView): string | null {
    if (event.sender !== view.webContents) {
      return null;
    }
    const frame = event.senderFrame;
    if (frame === null || frame.parent !== null) {
      return null;
    }
    return pageNameOf(frame.url, this.paths.pages);
  }

  private registerIpc(): void {
    ipcMain.on(CHANNEL_ACTION, (event, name: unknown, ...extra: unknown[]) => {
      if (extra.length > 0) {
        return;
      }
      if (isToolbarAction(name) && this.senderPage(event, this.toolbar) === "toolbar.html") {
        this.toolbarAction(name);
        return;
      }
      const page = this.senderPage(event, this.local);
      if (isPageAction(name) && page !== null) {
        this.pageAction(name, page);
      }
    });
    ipcMain.handle(CHANNEL_GET_STATUS, (event) => {
      if (this.senderPage(event, this.toolbar) !== "toolbar.html") {
        throw new Error("forbidden");
      }
      return this.status();
    });
    ipcMain.handle(CHANNEL_GET_SETUP, (event) => {
      if (this.senderPage(event, this.local) !== "setup.html") {
        throw new Error("forbidden");
      }
      return this.setupInfo();
    });
    ipcMain.handle(CHANNEL_SAVE_SETUP, (event, url: unknown, token: unknown, ...extra: unknown[]) => {
      if (this.senderPage(event, this.local) !== "setup.html") {
        throw new Error("forbidden");
      }
      if (extra.length > 0 || typeof url !== "string" || typeof token !== "string" || url.length > MAX_URL_LENGTH || token.length > MAX_TOKEN_LENGTH * 2) {
        throw new Error("invalid arguments");
      }
      return this.saveSetup(url, token);
    });
  }

  private onInput(contents: WebContents, event: Electron.Event, input: Input): void {
    if (input.type !== "keyDown") {
      return;
    }
    const modifier = process.platform === "darwin" ? input.meta : input.control;
    const key = input.key.toLowerCase();
    const handled = (): void => event.preventDefault();
    if (input.key === "F5" || (modifier && key === "r")) {
      handled();
      this.reload();
    } else if (modifier && key === ",") {
      handled();
      this.toolbarAction("settings");
    } else if (modifier && (key === "=" || key === "+") && this.mode === "dashboard") {
      handled();
      this.dashboard.webContents.setZoomLevel(Math.min(4, this.dashboard.webContents.getZoomLevel() + ZOOM_STEP));
    } else if (modifier && key === "-" && this.mode === "dashboard") {
      handled();
      this.dashboard.webContents.setZoomLevel(Math.max(-3, this.dashboard.webContents.getZoomLevel() - ZOOM_STEP));
    } else if (modifier && key === "0" && this.mode === "dashboard") {
      handled();
      this.dashboard.webContents.setZoomLevel(0);
    } else if (!app.isPackaged && (input.key === "F12" || (modifier && input.shift && key === "i"))) {
      handled();
      contents.toggleDevTools();
    }
  }

  private showContextMenu(contents: WebContents, params: ContextMenuParams): void {
    const template: MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      template.push(
        { label: "Cut", enabled: params.editFlags.canCut, click: () => contents.cut() },
        { label: "Copy", enabled: params.editFlags.canCopy, click: () => contents.copy() },
        { label: "Paste", enabled: params.editFlags.canPaste, click: () => contents.paste() },
        { type: "separator" },
        { label: "Select all", click: () => contents.selectAll() }
      );
    } else if (params.selectionText.trim().length > 0) {
      template.push({ label: "Copy", click: () => contents.copy() });
    }
    if (contents === this.dashboard.webContents && params.linkURL.startsWith("https://")) {
      template.push({ label: "Open link in browser", click: () => openExternalHttps(params.linkURL) });
    }
    if (template.length > 0) {
      Menu.buildFromTemplate(template).popup({ window: this.window });
    }
  }
}
