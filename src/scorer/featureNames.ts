export const CONTEXT_FEATURES = ["age_sec", "mcap_multiple", "is_sol_quoted"] as const;

export const DEV_FEATURES = ["dev_initial_share", "dev_share", "dev_sold_fraction"] as const;

export const BUNDLE_FEATURES = ["creation_slot_buyers", "bundle_bought_share", "bundle_share"] as const;

export const DEEP_FEATURES = [
  "intel_coverage",
  "fresh_wallet_ratio",
  "largest_cluster_size",
  "largest_cluster_share",
  "cluster_count",
  "dev_funded_buyers"
] as const;

export const HOLDER_FEATURES = ["early_buyers", "top10_share"] as const;

export const DEV_HISTORY_FEATURES = [
  "dev_launch_count",
  "dev_outcome_count",
  "dev_rug_rate",
  "dev_migration_rate",
  "dev_median_peak_multiple"
] as const;

export const FLOW_FEATURES = [
  "unique_buyers_per_min",
  "trades_per_min",
  "buy_sell_count_ratio",
  "buy_sell_volume_ratio",
  "volume_hhi",
  "wash_ratio"
] as const;

export const METADATA_FEATURES = ["has_twitter", "has_telegram", "has_website", "socials_count"] as const;

export const COPYCAT_FEATURES = ["copycat", "copycat_similarity", "same_ticker_recent"] as const;

export const FEATURE_NAMES: readonly string[] = [
  ...CONTEXT_FEATURES,
  ...DEV_FEATURES,
  ...BUNDLE_FEATURES,
  ...HOLDER_FEATURES,
  ...DEEP_FEATURES,
  ...DEV_HISTORY_FEATURES,
  ...FLOW_FEATURES,
  ...METADATA_FEATURES,
  ...COPYCAT_FEATURES
];

export const REPLAY_STORED_FEATURES: readonly string[] = [
  ...DEEP_FEATURES,
  ...METADATA_FEATURES,
  ...COPYCAT_FEATURES,
  ...DEV_HISTORY_FEATURES
];

export const NON_PREDICTIVE_FEATURES: readonly string[] = ["age_sec", "intel_coverage"];
