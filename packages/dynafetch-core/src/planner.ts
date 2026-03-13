import type { HarvestResult } from "../../../src/phantom/types.ts";
import type { DynafetchFramework, DynafetchPlan } from "./types";

export function planDynafetch(
  framework: DynafetchFramework,
  harvest: HarvestResult,
  allowJsdomFallback: boolean,
): DynafetchPlan {
  if (framework === "static" && harvest.scripts.length === 0) {
    return {
      framework,
      strategy: "static-html",
      reason: "document has no executable scripts; return the fetched HTML directly",
    };
  }

  if (!allowJsdomFallback) {
    return {
      framework,
      strategy: "static-html",
      reason: "dynamic execution disabled; return the fetched HTML without script execution",
    };
  }

  if (framework !== "generic-spa" && framework !== "static") {
    return {
      framework,
      strategy: "framework-probe",
      reason: "known framework markers detected; run the lightweight runtime under framework-aware labeling",
    };
  }

  return {
    framework,
    strategy: "jsdom-fallback",
    reason: "generic client-rendered page requires runtime execution to recover dynamic HTML",
  };
}
