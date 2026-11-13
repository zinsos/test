import { entryRulesOf } from "../src/analytics/positionQueries.js";
import { DASHBOARD_SCRIPT } from "../src/analytics/dashboardScript.js";
import { defaultStrategyConfig } from "../src/config/strategy.js";
import { mintAt } from "./analytics.db.js";

export const MINT = mintAt(40);
export const PENDING_MINT = mintAt(41);
export const READ_AT_MS = Date.UTC(2026, 9, 23, 12, 0, 0);
const TOKEN = "dom-token";

type Listener = (event: unknown) => void;

export class FakeNode {
  readonly childNodes: FakeNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, Listener[]>();
  parent: FakeNode | null = null;
  className = "";
  value = "";
  disabled = false;
  innerHTML = "";
  private ownText: string;

  constructor(
    readonly tagName: string,
    text = ""
  ) {
    this.ownText = text;
  }

  get children(): FakeNode[] {
    return this.childNodes.filter((node) => node.tagName !== "#text");
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  insertBefore(child: FakeNode, reference: FakeNode | null): FakeNode {
    if (!reference) {
      return this.appendChild(child);
    }
    child.remove();
    child.parent = this;
    const index = this.childNodes.indexOf(reference);
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child);
    return child;
  }

  removeChild(child: FakeNode): FakeNode {
    child.remove();
    return child;
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ target: this });
    }
  }

  get classList(): { add(name: string): void; remove(name: string): void } {
    return {
      add: (name) => {
        const names = new Set(this.className.split(" ").filter(Boolean));
        names.add(name);
        this.className = [...names].join(" ");
      },
      remove: (name) => {
        this.className = this.className
          .split(" ")
          .filter((item) => item && item !== name)
          .join(" ");
      }
    };
  }

  get textContent(): string {
    return this.tagName === "#text" ? this.ownText : this.childNodes.map((node) => node.textContent).join("");
  }

  set textContent(value: string) {
    if (this.tagName === "#text") {
      this.ownText = value;
      return;
    }
    this.clear();
    if (value) {
      this.appendChild(new FakeNode("#text", value));
    }
  }

  appendChild(child: FakeNode): FakeNode {
    if (child.tagName === "#fragment") {
      for (const inner of [...child.childNodes]) {
        this.appendChild(inner);
      }
      return child;
    }
    child.remove();
    child.parent = this;
    this.childNodes.push(child);
    return child;
  }

  append(...children: Array<FakeNode | string>): void {
    for (const child of children) {
      this.appendChild(typeof child === "string" ? new FakeNode("#text", child) : child);
    }
  }

  replaceChildren(...children: Array<FakeNode | string>): void {
    this.clear();
    this.append(...children);
  }

  remove(): void {
    if (!this.parent) {
      return;
    }
    const siblings = this.parent.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parent = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(): void {
    return;
  }

  contains(node: FakeNode | null): boolean {
    for (let current = node; current; current = current.parent) {
      if (current === this) {
        return true;
      }
    }
    return false;
  }

  focus(): void {
    return;
  }

  scrollIntoView(): void {
    return;
  }

  descendants(): FakeNode[] {
    return this.childNodes.flatMap((node) => [node, ...node.descendants()]);
  }

  private clear(): void {
    for (const child of [...this.childNodes]) {
      child.remove();
    }
  }
}

export interface RenderedView {
  text: string;
  links: string[];
  paths: string[];
  authHeaders: string[];
}

export interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type Responder = (path: string) => Promise<FakeResponse>;

export interface DashboardOptions {
  storage?: Record<string, string>;
  hash?: string;
  search?: string;
  responder?: Responder;
  eventSource?: boolean;
}

type StreamListener = (message: { data: string; lastEventId?: string }) => void;

export class FakeEventSource {
  readyState = 0;
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: StreamListener | null = null;
  onerror: ((event: unknown) => void) | null = null;
  private readonly listeners = new Map<string, StreamListener[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: StreamListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.readyState = 2;
    this.closed = true;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  send(event: string, data: unknown, id = ""): void {
    const message = { data: JSON.stringify(data), lastEventId: id };
    if (event === "message") {
      this.onmessage?.(message);
      return;
    }
    for (const listener of this.listeners.get(event) ?? []) {
      listener(message);
    }
  }

  fail(closed: boolean): void {
    this.readyState = closed ? 2 : 0;
    this.onerror?.({});
  }
}

export interface DashboardHarness {
  paths: string[];
  authHeaders: string[];
  storage: Map<string, string>;
  streams: FakeEventSource[];
  location: { hash: string };
  change(label: string, value: string): Promise<void>;
  click(text: string): Promise<void>;
  find(className: string): FakeNode[];
  bodyText(): string;
  flush(): Promise<void>;
  setResponder(responder: Responder): void;
  setVisibility(state: "visible" | "hidden"): void;
  focus(tag: string | null): void;
  advance(ms: number): Promise<void>;
  view(): RenderedView;
  updated(): string;
}

export function jsonResponse(body: unknown, status = 200): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

export function neverResponds(): Promise<FakeResponse> {
  return new Promise(() => undefined);
}

async function settle(): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

interface Interval {
  run: () => void;
  everyMs: number;
  lastMs: number;
}

export async function startDashboard(positions: Record<string, unknown>, options: DashboardOptions = {}): Promise<DashboardHarness> {
  const body = new FakeNode("body");
  const storage = new Map<string, string>(Object.entries(options.storage ?? {}));
  const paths: string[] = [];
  const authHeaders: string[] = [];
  const intervals: Interval[] = [];
  let nowMs = READ_AT_MS;
  let responder: Responder =
    options.responder ?? ((path) => Promise.resolve(jsonResponse(path.startsWith("/api/runs") ? { runs: [], modes: [] } : positions)));
  const streams: FakeEventSource[] = [];
  const document = {
    readyState: "complete",
    visibilityState: "visible",
    activeElement: null as FakeNode | null,
    body,
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => new FakeNode("#text", text),
    createDocumentFragment: () => new FakeNode("#fragment"),
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  };
  const window = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key)
    },
    location: { hash: options.hash ?? "", search: options.search ?? `?token=${TOKEN}`, pathname: "/" },
    history: { replaceState: () => undefined },
    addEventListener: () => undefined,
    setInterval: (run: () => void, everyMs: number) => {
      intervals.push({ run, everyMs, lastMs: nowMs });
      return intervals.length;
    },
    setTimeout: () => 0,
    EventSource: options.eventSource
      ? class extends FakeEventSource {
          constructor(url: string) {
            super(url);
            streams.push(this);
          }
        }
      : undefined
  };
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args: [] | [number]) {
      super(args.length ? args[0] : nowMs);
    }
    static override now(): number {
      return nowMs;
    }
  }
  const fetch = (path: string, init: { headers?: Record<string, string> }) => {
    if (path === "/healthz") {
      return Promise.resolve(jsonResponse({ ok: true }));
    }
    paths.push(path);
    authHeaders.push(init.headers?.Authorization ?? "");
    return responder(path);
  };
  new Function("window", "document", "fetch", "Date", DASHBOARD_SCRIPT)(window, document, fetch, FakeDate);
  await settle();
  const main = (): FakeNode | undefined => body.descendants().find((node) => node.tagName === "main");
  const nodes = (): FakeNode[] => body.descendants();
  return {
    paths,
    authHeaders,
    storage,
    streams,
    location: window.location,
    async change(label, value) {
      const select = nodes().find((node) => node.tagName === "select" && node.getAttribute("aria-label") === label);
      if (!select) {
        throw new Error(`no select ${label}`);
      }
      select.value = value;
      select.dispatch("change");
      await settle();
    },
    async click(text) {
      const button = nodes().find((node) => node.tagName === "button" && node.textContent.startsWith(text));
      if (!button) {
        throw new Error(`no button ${text}`);
      }
      button.dispatch("click");
      await settle();
    },
    find(className) {
      return nodes().filter((node) => node.className.split(" ").includes(className));
    },
    bodyText() {
      return body.textContent;
    },
    flush() {
      return settle();
    },
    setResponder(next) {
      responder = next;
    },
    setVisibility(state) {
      document.visibilityState = state;
    },
    focus(tag) {
      document.activeElement = tag === null ? null : main()?.descendants().find((node) => node.tagName === tag) ?? null;
    },
    async advance(ms) {
      const target = nowMs + ms;
      while (nowMs < target) {
        nowMs = Math.min(target, nowMs + 1_000);
        for (const interval of intervals) {
          if (nowMs - interval.lastMs >= interval.everyMs) {
            interval.lastMs = nowMs;
            interval.run();
          }
        }
        await settle();
      }
    },
    view() {
      const nodes = main()?.descendants() ?? [];
      return {
        text: main()?.textContent ?? "",
        links: nodes.filter((node) => node.tagName === "a").map((node) => node.getAttribute("href") ?? ""),
        paths: [...paths],
        authHeaders: [...authHeaders]
      };
    },
    updated() {
      return body.descendants().find((node) => node.className === "updated")?.textContent ?? "";
    }
  };
}

export async function renderTradesView(positions: Record<string, unknown>, options: DashboardOptions = {}): Promise<RenderedView> {
  return (await startDashboard(positions, options)).view();
}

export function tradesFixture(): Record<string, unknown> {
  const config = defaultStrategyConfig();
  config.signals.enabled = ["score_momentum", "smart_convergence"];
  return {
    filter: { runId: null, mode: null },
    readAtMs: READ_AT_MS,
    run: { id: 1, mode: "paper", label: null, startedAtMs: READ_AT_MS - 2 * 3_600_000, endedAtMs: null, active: true },
    bankroll: {
      startingSol: 5,
      realizedPnlSol: 0.25,
      unrealizedPnlSol: 0.1,
      equitySol: 5.35,
      peakEquitySol: 5.4,
      dayKey: "2026-10-23",
      dayStartEquitySol: 5.1,
      dayPnlSol: 0.25,
      haltedForDay: true,
      haltedUntilMs: READ_AT_MS + 3_600_000,
      killed: false,
      killReason: null,
      updatedAtMs: READ_AT_MS - 5_000
    },
    openPnlEstimateSol: 0.1473,
    equityEstimateSol: 5.3973,
    todayKey: "2026-10-23",
    todayPnlEstimateSol: 0.2973,
    open: [
      {
        id: "1-a",
        mode: "paper",
        status: "open",
        mint: MINT,
        name: "Alpha Coin",
        symbol: "ALPHA",
        signalType: "score_momentum",
        riskScore: 18,
        openedAtMs: READ_AT_MS - 600_000,
        ageSec: 600,
        entryCostSol: 0.1,
        budgetSol: null,
        entryPrice: 2 ** -15,
        lastPrice: 2 ** -13,
        peakPrice: 2 ** -12,
        multiple: 4,
        peakMultiple: 8,
        entryTokens: "3276800000000",
        tokensHeld: "1638400000000",
        soldPct: 50,
        proceedsSol: 0.05,
        feesPaidSol: 0.002,
        sellFeeBps: 135,
        sellFeeSource: "last_trade",
        estimatedValueSol: 0.1973,
        estimatedPnlSol: 0.1473,
        estimatedPnlPct: 147.3,
        takeProfitLevelsHit: 1,
        migrated: false,
        exiting: null,
        lastTradeAtMs: READ_AT_MS - 120_000,
        pumpUrl: `https://pump.fun/coin/${MINT}`
      },
      {
        id: "1-p",
        mode: "paper",
        status: "pending",
        mint: PENDING_MINT,
        name: null,
        symbol: null,
        signalType: "smart_convergence",
        riskScore: 30,
        openedAtMs: READ_AT_MS - 60_000,
        ageSec: 60,
        entryCostSol: 0,
        budgetSol: 0.15,
        entryPrice: null,
        lastPrice: null,
        peakPrice: null,
        multiple: null,
        peakMultiple: null,
        entryTokens: "0",
        tokensHeld: "0",
        soldPct: null,
        proceedsSol: 0,
        feesPaidSol: 0,
        sellFeeBps: 125,
        sellFeeSource: "default",
        estimatedValueSol: null,
        estimatedPnlSol: null,
        estimatedPnlPct: null,
        takeProfitLevelsHit: 0,
        migrated: false,
        exiting: null,
        lastTradeAtMs: null,
        pumpUrl: `https://pump.fun/coin/${PENDING_MINT}`
      }
    ],
    recentClosed: [
      {
        id: "1-c",
        mint: MINT,
        name: "Alpha Coin",
        symbol: "ALPHA",
        signalType: "score_momentum",
        riskScore: 20,
        openedAtMs: READ_AT_MS - 3_600_000,
        closedAtMs: READ_AT_MS - 1_800_000,
        holdSec: 1_800,
        costSol: 0.1,
        proceedsSol: 0.16,
        feesPaidSol: 0.002,
        pnlSol: 0.06,
        pnlPct: 60,
        peakMultiple: 2.1,
        exitReason: "trailing_stop",
        pumpUrl: `https://pump.fun/coin/${MINT}`
      }
    ],
    counts: {
      open: 1,
      pending: 1,
      closed: 1,
      openedLast24h: 2,
      closedLast24h: 1,
      winsLast24h: 1,
      realizedLast24hSol: 0.06,
      lastOpenedAtMs: READ_AT_MS - 60_000,
      lastClosedAtMs: READ_AT_MS - 1_800_000
    },
    activity: {
      windowHours: 24,
      byType: [{ type: "score_momentum", total: 4, acted: 2, lastAtMs: READ_AT_MS - 60_000 }],
      skipReasons: [{ reason: "max_open_positions", count: 2 }]
    },
    entryRules: entryRulesOf(config)
  };
}
