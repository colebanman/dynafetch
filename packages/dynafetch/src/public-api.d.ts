export type DynafetchThirdPartyPolicy = "skip-noncritical" | "execute-all";

export type DynafetchFramework =
  | "nextjs"
  | "nuxt"
  | "remix"
  | "inertia"
  | "astro"
  | "sveltekit"
  | "htmx"
  | "generic-spa"
  | "static";

export type DynafetchStrategy =
  | "static-html"
  | "framework-probe"
  | "jsdom-fallback";

export type DynafetchHarvestSnapshot = {
  html: string;
  initialState: Record<string, unknown>;
  scripts: Array<{ url?: string }>;
};

export type DynafetchProxyScope = "page" | "api" | "assets";

export type DynafetchProxyConfig = string | {
  url: string;
  only?: DynafetchProxyScope[];
};

export type DynafetchOptions = {
  url: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string> | string | string[];
  proxy?: DynafetchProxyConfig;
  timeoutMs?: number;
  browserProfile?: string;
  maxSubrequests?: number;
  allowJsdomFallback?: boolean;
  prefetchExternalScripts?: boolean;
  prefetchModulePreloads?: boolean;
  thirdPartyPolicy?: DynafetchThirdPartyPolicy;
  minWaitMs?: number;
  idleWaitMs?: number;
  maxWaitMs?: number;
  moduleWaitMs?: number;
};

export type DynafetchResult = {
  url: string;
  finalUrl: string;
  status: number;
  html: string;
  framework: DynafetchFramework;
  strategy: DynafetchStrategy;
  confidence: number;
  warnings: string[];
  timings: {
    total: number;
    harvest: number;
    execute: number;
    quiescence: number;
    scriptsTransformed: number;
  };
  requestCount: number;
};

export type DynafetchPlan = {
  framework: DynafetchFramework;
  strategy: DynafetchStrategy;
  reason: string;
};

export type DynafetchNetRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  headerOrder?: string[];
  body: string;
  proxy?: string;
};

export type DynafetchNetResponse = {
  status: number;
  body: string;
  headers: Record<string, string>;
  finalUrl?: string;
  error?: string;
  retried?: boolean;
};

export type DynafetchSessionOptions = {
  browserProfile?: string;
  timeoutSeconds?: number;
  proxy?: string;
  rpcTimeoutMs?: number;
};

export type DynafetchNetFetchOptions = DynafetchSessionOptions & {
  followRedirect?: boolean;
  maxRedirects?: number;
};

export declare class DynafetchInputError extends Error {
  status: number;
  constructor(message: string, status?: number);
}

export declare function detectFramework(harvest: DynafetchHarvestSnapshot): DynafetchFramework;

export declare function planDynafetch(
  framework: DynafetchFramework,
  harvest: DynafetchHarvestSnapshot,
  allowJsdomFallback: boolean,
): DynafetchPlan;

export declare function withDynafetchSession<T>(
  options: DynafetchSessionOptions,
  run: () => Promise<T>,
): Promise<T>;

export declare function dynafetchNetHealth(): Promise<{ ok: boolean; service: string }>;

export declare function dynafetchNetFetch(
  request: DynafetchNetRequest,
  options?: DynafetchNetFetchOptions,
): Promise<DynafetchNetResponse>;

export declare function dynafetchNetBatchFetch(
  requests: DynafetchNetRequest[],
  options?: DynafetchNetFetchOptions,
): Promise<DynafetchNetResponse[]>;

export declare function dynafetch(input: string | DynafetchOptions): Promise<DynafetchResult>;
