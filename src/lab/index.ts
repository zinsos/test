export {
  DEFAULT_LAB_CHECKPOINTS,
  DEFAULT_LAB_HOURS,
  DEFAULT_LAB_LABELS,
  DEFAULT_MAX_TRAIN_ROWS,
  DEFAULT_MIN_CLASS_ROWS,
  DEFAULT_MIN_TRAIN_ROWS,
  DEFAULT_TRAIN_HOURS,
  LabBusyError,
  MAX_LAB_HOURS,
  planVariants,
  runLab,
  variantNotes,
  type LabProgress,
  type LabResult,
  type LabVariantResult,
  type RunLabOptions
} from "./runner.js";
export { durationText, formatLabReport, pruneText, rankVariants } from "./report.js";
export {
  LAB_TOP_FEATURES,
  labelCounts,
  labScorerResult,
  labWeightsVersion,
  loadRecentRows,
  positiveCalibration,
  runScorerLab,
  skippedEntry,
  topFeatures,
  trainingWindow,
  type LabCalibrationBucket,
  type LabFeature,
  type LabScorerEntry,
  type LabScorerResult,
  type LabScorerSkip,
  type LabScorerSkipEntry
} from "./scorerLab.js";
export {
  acquireLabLock,
  DEFAULT_PRUNE_KEEP,
  LAB_LOCK_NAME,
  pruneLabRuns,
  type LabPruneResult,
  type LabStatus
} from "./store.js";
export { exitReasonBreakdown, labSummaryOf, type LabExitReason, type LabVariantSummary } from "./summary.js";
export {
  applyOverrides,
  BASELINE_NAME,
  changedSettings,
  deepMerge,
  inertReason,
  isLabLabel,
  LAB_LABEL_PREFIX,
  LAB_VARIANTS_FILE,
  labRunLabel,
  loadLabVariants,
  parseLabVariants,
  unknownSettings,
  unusedInReplay,
  type LabVariant
} from "./variants.js";
export {
  isPromotableSetting,
  loosenedCeilings,
  overridePaths,
  overridesHash,
  ownerOnlySettings,
  RISK_CEILINGS,
  shortHash,
  storedStrategyHash,
  strategyHash,
  undoOverrides,
  variantKey
} from "./identity.js";
export { computeEngineVersion, replayEngineVersion, REPLAY_ENGINE_DIRS } from "./engine.js";
export {
  confirmConfidenceOf,
  discoveryConfidenceOf,
  evaluateLearning,
  evaluateWeights,
  learnerRuleOf,
  selectWindows,
  storedTradesOf,
  UNDO_PREFIX,
  weightsRuleOf,
  type LearnerDecision,
  type LearnerReport,
  type VariantVerdict,
  type WeightsReport
} from "./learner.js";
export { fileSettings, learnedFrom, loadLearnedSettings, usesLearnedSettings, type LearnedSettings } from "./learned.js";
export { loadEvidenceWindows, loadPaperEvidence, runLearner } from "./learnerStore.js";
export {
  latestAppliedAtMs,
  latestEvent,
  loadPendingPromotion,
  reconcilePromotions,
  recentPromotions,
  type Promotion,
  type PromotionStatus
} from "./promotions.js";
