import { Executor } from "../../../src/phantom/execute.ts";
import { Harvester } from "../../../src/phantom/harvest.ts";
import type { ExecutionError } from "../../../src/phantom/types.ts";
import { assertSafeHttpUrlSync } from "../../../src/phantom/url-safety.ts";
import { detectFramework } from "./detect";
import { dynafetchNetBatchFetch, dynafetchNetFetch, dynafetchNetHealth, withDynafetchSession } from "./net/worker-client";
import { planDynafetch } from "./planner";
import type { DynafetchOptions, DynafetchPlan, DynafetchProxyConfig, DynafetchProxyScope, DynafetchResult } from "./types";

export type {
  DynafetchFramework,
  DynafetchHarvestSnapshot,
  DynafetchOptions,
  DynafetchPlan,
  DynafetchProxyConfig,
  DynafetchProxyScope,
  DynafetchResult,
  DynafetchStrategy,
} from "./types";

export {
  detectFramework,
  dynafetchNetBatchFetch,
  dynafetchNetFetch,
  dynafetchNetHealth,
  planDynafetch,
  withDynafetchSession,
};

class DynafetchInputError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "DynafetchInputError";
    this.status = status;
  }
}

export type NormalizedProxy = {
  url: string;
  scopes: Set<DynafetchProxyScope>;
};

function normalizeProxy(input?: DynafetchProxyConfig): NormalizedProxy | undefined {
  if (!input) return undefined;
  if (typeof input === "string") {
    const url = input.trim();
    if (!url) return undefined;
    return { url, scopes: new Set(["page", "api", "assets"]) };
  }
  const url = input.url?.trim();
  if (!url) return undefined;
  const scopes = input.only?.length
    ? new Set<DynafetchProxyScope>(input.only)
    : new Set<DynafetchProxyScope>(["page", "api", "assets"]);
  return { url, scopes };
}

function normalizeCookies(input: DynafetchOptions["cookies"]): string[] {
  if (!input) return [];
  if (typeof input === "string") {
    return input
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (Array.isArray(input)) {
    return input.map((value) => value.trim()).filter(Boolean);
  }
  return Object.entries(input).map(([key, value]) => `${key}=${value}`);
}

function normalizeOptions(input: string | DynafetchOptions): DynafetchOptions {
  const options = typeof input === "string" ? { url: input } : input;
  if (!options?.url) {
    throw new DynafetchInputError("URL is required");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = assertSafeHttpUrlSync(options.url);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid URL";
    throw new DynafetchInputError(message);
  }

  return {
    ...options,
    url: parsedUrl.toString(),
    allowJsdomFallback: options.allowJsdomFallback !== false,
    browserProfile: options.browserProfile?.trim() || "chrome_146",
    prefetchExternalScripts: options.prefetchExternalScripts !== false,
    prefetchModulePreloads: options.prefetchModulePreloads !== false,
    thirdPartyPolicy: options.thirdPartyPolicy ?? "skip-noncritical",
  };
}

function toWarnings(
  plan: DynafetchPlan,
  errors: ExecutionError[] | undefined,
  options: DynafetchOptions,
  runtimeWarnings: string[] = [],
): string[] {
  const warnings = [plan.reason];
  for (const warning of runtimeWarnings) {
    if (warning && !warnings.includes(warning)) {
      warnings.push(warning);
    }
  }

  if (plan.strategy === "jsdom-fallback" || plan.strategy === "framework-probe") {
    warnings.push("runtime execution used the legacy JSDOM-based renderer while lightweight adapters are still being built");
  }
  if (options.maxSubrequests) {
    warnings.push(`maxSubrequests is advisory in the current implementation (${options.maxSubrequests})`);
  }
  if (options.thirdPartyPolicy === "skip-noncritical") {
    warnings.push("non-critical third-party scripts are skipped on the critical render path");
  }
  if (errors?.length) {
    for (const error of errors.slice(0, 3)) {
      warnings.push(`${error.source}: ${error.message}`);
    }
  }
  return warnings;
}

function computeConfidence(params: {
  plan: DynafetchPlan;
  initialStateCount: number;
  executionErrors: number;
  htmlLength: number;
}): number {
  let confidence = params.plan.strategy === "static-html" ? 0.92 : 0.68;

  if (params.plan.framework !== "generic-spa" && params.plan.framework !== "static") {
    confidence += 0.08;
  }
  if (params.initialStateCount > 0) {
    confidence += 0.06;
  }
  if (params.plan.strategy === "jsdom-fallback") {
    confidence -= 0.08;
  }
  if (params.htmlLength < 256) {
    confidence -= 0.1;
  }

  confidence -= Math.min(0.28, params.executionErrors * 0.07);
  return Math.max(0.05, Math.min(0.98, Number(confidence.toFixed(2))));
}

function createTimeoutError(timeoutMs: number): Error {
  const error = new Error(`dynafetch timed out after ${timeoutMs}ms`);
  error.name = "DynafetchTimeoutError";
  return error;
}

async function withOperationTimeout<T>(operation: Promise<T>, timeoutMs?: number): Promise<T> {
  if (!timeoutMs || !Number.isFinite(timeoutMs)) {
    return await operation;
  }

  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(createTimeoutError(Math.max(1, Math.ceil(timeoutMs)))), Math.max(1, Math.ceil(timeoutMs)));
    timer.unref?.();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Fetch a URL with full browser emulation — Chrome TLS fingerprinting,
 * JavaScript execution, and network interception — then return the
 * rendered HTML and metadata.
 *
 * Uses Chrome 146 headers by default. Any headers you provide are merged
 * on top — your values override the defaults, everything else stays.
 *
 * @example
 * ```ts
 * // Minimal — just a URL
 * const page = await dynafetch("https://example.com");
 *
 * // With custom headers, cookies, and proxy
 * const page = await dynafetch({
 *   url: "https://example.com",
 *   headers: { "Accept-Language": "fr-FR" },
 *   cookies: { session: "abc123" },
 *   proxy: "http://user:pass@ip:port",
 * });
 *
 * // Smart proxy — only proxy the HTML page and API calls
 * const page = await dynafetch({
 *   url: "https://example.com",
 *   proxy: { url: "http://user:pass@ip:port", only: ["page", "api"] },
 * });
 *
 * // Tune quiescence — how long to wait for the page to settle
 * const page = await dynafetch({
 *   url: "https://example.com",
 *   maxWaitMs: 3000,   // wait up to 3s for async requests to finish
 *   idleWaitMs: 150,   // 150ms of silence = page is settled
 * });
 * ```
 *
 * **Options at a glance:**
 *
 * | Option | Default | Description |
 * |---|---|---|
 * | `headers` | Chrome 146 | Merged on top of defaults — yours override on conflict |
 * | `cookies` | none | String, array, or `Record<string, string>` |
 * | `proxy` | none | `"http://user:pass@ip:port"` or `{ url, only: ["page","api","assets"] }` |
 * | `minWaitMs` | `75` | Min ms before checking if page is idle |
 * | `idleWaitMs` | `100` | Ms of zero pending requests = settled |
 * | `maxWaitMs` | `3000` | Hard cap on wait time regardless of activity |
 * | `moduleWaitMs` | `6000` | Max ms for ES module bundling (esbuild) |
 * | `timeoutMs` | none | Overall timeout for the entire operation |
 * | `thirdPartyPolicy` | `"skip-noncritical"` | Skip analytics/ads/chat scripts |
 *
 * **Proxy scopes** — when using `{ url, only }`:
 * - `"page"` — initial HTML document fetch
 * - `"api"` — fetch() and XHR calls from page scripts
 * - `"assets"` — JS scripts, ES modules, static resources
 *
 * **Speed presets:**
 * - Fast: `{ maxWaitMs: 1000, idleWaitMs: 50 }`
 * - Thorough: `{ maxWaitMs: 5000, idleWaitMs: 200 }`
 */
export async function dynafetch(input: string | DynafetchOptions): Promise<DynafetchResult> {
  const options = normalizeOptions(input);
  const timeoutSeconds = options.timeoutMs ? Math.max(1, Math.ceil(options.timeoutMs / 1000)) : undefined;
  const deadlineAt = options.timeoutMs ? Date.now() + options.timeoutMs : undefined;
  const initialCookies = normalizeCookies(options.cookies);
  const proxy = normalizeProxy(options.proxy);

  return await withOperationTimeout(
    withDynafetchSession(
      {
        browserProfile: options.browserProfile,
        timeoutSeconds,
        proxy: proxy?.url,
        rpcTimeoutMs: options.timeoutMs,
      },
      async () => {
        const totalStart = Date.now();
        const harvestStart = Date.now();
        const harvester = new Harvester(options.url, {
          prefetchExternalScripts: options.prefetchExternalScripts,
          prefetchModulePreloads: options.prefetchModulePreloads,
          requestHeaders: options.headers,
          initialCookies,
          thirdPartyPolicy: options.thirdPartyPolicy,
          proxy,
          timeoutMs: options.timeoutMs,
          deadlineAt,
        });
        const harvest = await harvester.harvest();
        const harvestMs = Date.now() - harvestStart;

        const framework = detectFramework(harvest);
        const plan = planDynafetch(framework, harvest, options.allowJsdomFallback !== false);

        let html = harvest.html;
        let requestCount = harvest.logs.length;
        let executionErrors: ExecutionError[] | undefined;
        let executionWarnings: string[] = [];
        let executeMs = 0;
        let quiescenceMs = 0;
        let scriptsTransformed = 0;

        if (plan.strategy !== "static-html") {
          const executeStart = Date.now();
          const executor = new Executor(harvest, {
            thirdPartyPolicy: options.thirdPartyPolicy,
            quiescence: {
              minWaitMs: options.minWaitMs,
              idleWaitMs: options.idleWaitMs,
              maxWaitMs: options.maxWaitMs,
            },
            moduleWaitMs: options.moduleWaitMs,
            proxy,
            timeoutMs: options.timeoutMs,
            deadlineAt,
          });
          const execution = await executor.execute();
          executeMs = Date.now() - executeStart;
          html = execution.renderedHtml ?? harvest.html;
          requestCount = execution.logs.length;
          executionErrors = execution.errors;
          executionWarnings = execution.warnings ?? [];
          quiescenceMs = execution.timings?.quiescence_ms ?? 0;
          scriptsTransformed = execution.timings?.scripts_transformed_count ?? 0;
        }

        const totalMs = Date.now() - totalStart;
        const warnings = toWarnings(
          plan,
          executionErrors,
          options,
          [...(harvest.warnings ?? []), ...executionWarnings],
        );
        const confidence = computeConfidence({
          plan,
          initialStateCount: Object.keys(harvest.initialState).length,
          executionErrors: executionErrors?.length ?? 0,
          htmlLength: html.length,
        });

        return {
          url: options.url,
          finalUrl: harvest.url,
          status: harvest.status,
          html,
          framework,
          strategy: plan.strategy,
          confidence,
          warnings,
          timings: {
            total: totalMs,
            harvest: harvestMs,
            execute: executeMs,
            quiescence: quiescenceMs,
            scriptsTransformed,
          },
          requestCount,
        };
      },
    ),
    options.timeoutMs,
  );
}

export { DynafetchInputError };
