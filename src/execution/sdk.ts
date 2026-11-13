import { createRequire } from "node:module";

export type PumpSdkModule = typeof import("@pump-fun/pump-sdk");
export type PumpSwapSdkModule = typeof import("@pump-fun/pump-swap-sdk");

const requireCommonJs = createRequire(import.meta.url);

let pumpSdk: PumpSdkModule | null = null;
let pumpSwapSdk: PumpSwapSdkModule | null = null;

export function loadPumpSdk(): PumpSdkModule {
  pumpSdk ??= requireCommonJs("@pump-fun/pump-sdk") as PumpSdkModule;
  return pumpSdk;
}

export function loadPumpSwapSdk(): PumpSwapSdkModule {
  pumpSwapSdk ??= requireCommonJs("@pump-fun/pump-swap-sdk") as PumpSwapSdkModule;
  return pumpSwapSdk;
}
