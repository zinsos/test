import { entryRulesOf } from "../src/analytics/positionQueries.js";
import { DASHBOARD_SCRIPT } from "../src/analytics/dashboardScript.js";
import { defaultStrategyConfig } from "../src/config/strategy.js";
import { mintAt } from "./analytics.db.js";

export const MINT = mintAt(40);
export const PENDING_MINT = mintAt(41);
const READ_AT_MS = Date.UTC(2026, 9, 23, 12, 0, 0);
const TOKEN = "dom-token";

type Listener = (event: unknown) => void;

class FakeNode {
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

function response(body: unknown): { ok: boolean; status: number; json(): Promise<unknown> } {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export async function renderTradesView(positions: Record<string, unknown>): Promise<RenderedView> {
  const body = new FakeNode("body");
  const storage = new Map<string, string>();
  const paths: string[] = [];
  const authHeaders: string[] = [];
  const document = {
    readyState: "complete",
    visibilityState: "visible",
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
    location: { hash: "", search: `?token=${TOKEN}`, pathname: "/" },
    history: { replaceState: () => undefined },
    addEventListener: () => undefined,
    setInterval: () => 0,
    setTimeout: () => 0
  };
  const fetch = (path: string, init: { headers?: Record<string, string> }) => {
    if (path === "/healthz") {
      return Promise.resolve(response({ ok: true }));
    }
    paths.push(path);
    authHeaders.push(init.headers?.Authorization ?? "");
    return Promise.resolve(response(path.startsWith("/api/runs") ? { runs: [], modes: [] } : positions));
  };
  new Function("window", "document", "fetch", DASHBOARD_SCRIPT)(window, document, fetch);
  await settle();
  const main = body.descendants().find((node) => node.tagName === "main");
  const nodes = main?.descendants() ?? [];
  return {
    text: main?.textContent ?? "",
    links: nodes.filter((node) => node.tagName === "a").map((node) => node.getAttribute("href") ?? ""),
    paths,
    authHeaders
  };
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
