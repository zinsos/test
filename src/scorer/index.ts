import type { ScorerConfig } from "../config/strategy.js";
import type { Bus } from "../core/bus.js";
import type { Clock } from "../core/clock.js";
import { moduleLogger } from "../core/logger.js";
import type { Db } from "../db/pool.js";
import { TrendingTracker } from "./copycat.js";
import { DevHistoryService } from "./devHistory.js";
import { WalletIntelService, type IntelRpc } from "./intel.js";
import { loadScoringModel, ScoringModel, type WeightsSource } from "./model.js";
import { LaunchScoreStore } from "./scoreStore.js";
import { ScorerService, type LaunchSource, type ScorerMode } from "./service.js";
import { seedTrending } from "./trendingSeed.js";
import type { StoredFeaturesLookup } from "./types.js";

const log = moduleLogger("scorer-module");

export type IntelMode = "fetch" | "stored";

export interface ScorerModuleOptions {
  db: Db | null;
  rpc: IntelRpc | null;
  bus: Bus;
  market: LaunchSource;
  clock: Clock;
  config: ScorerConfig;
  mode: ScorerMode;
  storedFeatures?: StoredFeaturesLookup | null;
  model?: ScoringModel | null;
  weightsFile?: string | null;
  persistScores?: boolean;
  intelMode?: IntelMode;
}

export interface ScorerModule {
  service: ScorerService;
  trending: TrendingTracker;
  intel: WalletIntelService | null;
  devHistory: DevHistoryService | null;
  store: LaunchScoreStore | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  reloadWeights(): Promise<WeightsSource>;
}

export function createScorerModule(options: ScorerModuleOptions): ScorerModule {
  const live = options.mode === "live";
  const trending = new TrendingTracker({ config: options.config });
  const intelRpc = (options.intelMode ?? "fetch") === "fetch" ? options.rpc : null;
  const intel =
    live && options.config.deepIntel.enabled && (intelRpc || options.db)
      ? new WalletIntelService({ db: options.db, rpc: intelRpc, clock: options.clock, config: options.config })
      : null;
  const devHistory = options.db ? new DevHistoryService({ db: options.db }) : null;
  const persist = options.persistScores ?? live;
  const store = persist && options.db ? new LaunchScoreStore({ db: options.db }) : null;
  const service = new ScorerService({
    clock: options.clock,
    bus: options.bus,
    market: options.market,
    config: options.config,
    model: options.model ?? ScoringModel.default(),
    intel,
    devHistory,
    trending,
    store: store ? store.sink : null,
    mode: options.mode,
    storedFeatures: options.storedFeatures ?? null
  });
  let detachTrending: (() => void) | null = null;
  let seeded = false;

  const seedTrendingFromHistory = async (db: Db): Promise<void> => {
    seeded = true;
    try {
      const result = await seedTrending(db, trending, {
        nowMs: options.clock.nowMs(),
        windowMinutes: options.config.copycat.trendingWindowMinutes
      });
      log.info(result, "copycat trending seeded from recorded launches");
    } catch (error) {
      log.warn({ err: error }, "copycat trending seed failed, starting empty");
    }
  };

  const reloadWeights = async (): Promise<WeightsSource> => {
    const loaded = await loadScoringModel({ db: options.db, filePath: options.weightsFile ?? options.config.weightsFile });
    service.setModel(loaded.model);
    log.info({ source: loaded.source, version: loaded.model.version }, "scorer weights loaded");
    return loaded.source;
  };

  return {
    service,
    trending,
    intel,
    devHistory,
    store,
    async start() {
      if (!options.model) {
        await reloadWeights();
      }
      if (options.db && !seeded) {
        await seedTrendingFromHistory(options.db);
      }
      if (!detachTrending) {
        detachTrending = trending.attach(options.bus);
      }
      store?.start();
      service.start();
    },
    async stop() {
      await service.stop();
      detachTrending?.();
      detachTrending = null;
      await intel?.stop();
      await store?.stop();
    },
    reloadWeights
  };
}

export { TrendingTracker } from "./copycat.js";
export { seedTrending, type TrendingSeedOptions, type TrendingSeedResult } from "./trendingSeed.js";
export { DevHistoryService, EMPTY_DEV_HISTORY } from "./devHistory.js";
export { WalletIntelService, LINKING_ENTITY_KINDS, type IntelRpc } from "./intel.js";
export { ScoringModel, loadScoringModel, riskAt, hardBlockFlags, exceedsRisk, type ModelScore } from "./model.js";
export { LaunchScoreStore } from "./scoreStore.js";
export { ScorerService, overlayStored, type LaunchSource, type ScorerMode } from "./service.js";
export { StoredFeaturesIndex, loadStoredFeatures } from "./storedFeatures.js";
export { computeFeatures, intelRequestsFor, type FeatureContext, type FeatureResult } from "./features.js";
export { buildFundingClusters, type FundingCluster } from "./clusters.js";
export { FEATURE_NAMES, REPLAY_STORED_FEATURES } from "./featureNames.js";
export {
  DEFAULT_WEIGHTS,
  loadActiveWeights,
  loadWeightsFile,
  parseWeights,
  saveWeights,
  writeWeightsFile,
  type WeightsFile
} from "./weights.js";
export {
  buildDataset,
  csvHeader,
  csvLine,
  DATASET_LABELS,
  datasetColumns,
  exportCsv,
  iterateDataset,
  labelValue,
  streamDatasetCsv,
  type DatasetLabelName,
  type DatasetQuery,
  type DatasetRow
} from "./dataset.js";
export { calibrationTable, tune, type FeatureReport, type TuneOptions, type TuneResult } from "./tune.js";
export type * from "./types.js";
