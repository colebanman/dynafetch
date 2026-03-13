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

/**
 * Which request categories should be routed through the proxy.
 *
 * - `"page"` — the initial HTML document fetch (and redirects)
 * - `"api"` — `fetch()` and `XMLHttpRequest` calls made by page scripts
 * - `"assets"` — external JS scripts, ES modules, and other static resources
 */
export type DynafetchProxyScope = "page" | "api" | "assets";

/**
 * Proxy configuration. Pass a URL string to proxy all requests,
 * or an object for fine-grained control over which requests use the proxy.
 *
 * ```ts
 * // Proxy everything
 * proxy: "http://user:pass@ip:port"
 *
 * // Only proxy the HTML page and API calls (saves bandwidth on static assets)
 * proxy: {
 *   url: "http://user:pass@ip:port",
 *   only: ["page", "api"],
 * }
 * ```
 */
export type DynafetchProxyConfig = string | {
  /** Proxy URL in `http://user:pass@host:port` format. */
  url: string;
  /**
   * Which request types to route through the proxy.
   * Omit to proxy everything.
   *
   * - `"page"` — initial HTML fetch
   * - `"api"` — fetch/XHR calls from page scripts
   * - `"assets"` — JS scripts, ES modules, static resources
   */
  only?: DynafetchProxyScope[];
};

export type DynafetchOptions = {
  /** Target URL to fetch and render. */
  url: string;

  /**
   * Extra request headers merged on top of the default Chrome 146 headers.
   * Any header you set here overrides the built-in default for that key.
   * Headers you don't set keep their Chrome-like defaults (User-Agent,
   * Accept, Sec-Fetch-*, etc.).
   *
   * ```ts
   * headers: {
   *   "Accept-Language": "fr-FR",  // overrides default "en-US,en;q=0.9"
   *   "X-Custom": "value",         // added alongside Chrome defaults
   * }
   * ```
   */
  headers?: Record<string, string>;

  /**
   * Cookies to include. Accepts:
   * - `string` — raw `Cookie` header value (`"k1=v1; k2=v2"`)
   * - `string[]` — individual `name=value` pairs
   * - `Record<string, string>` — key/value map
   */
  cookies?: Record<string, string> | string | string[];

  /**
   * Proxy configuration. Routes requests through an HTTP/HTTPS proxy with
   * TLS fingerprint preservation.
   *
   * ```ts
   * // Proxy all requests
   * proxy: "http://user:pass@ip:port"
   *
   * // Only proxy the page fetch and API calls (skip static assets)
   * proxy: { url: "http://user:pass@ip:port", only: ["page", "api"] }
   * ```
   */
  proxy?: DynafetchProxyConfig;

  /** Overall timeout for the entire operation in milliseconds. */
  timeoutMs?: number;

  /** TLS client profile to impersonate. @default `"chrome_146"` */
  browserProfile?: string;

  /** Advisory limit on sub-requests the executor may issue. */
  maxSubrequests?: number;

  /** Allow JSDOM-based script execution for dynamic pages. @default `true` */
  allowJsdomFallback?: boolean;

  /** Pre-fetch external `<script src>` tags during harvest. @default `true` */
  prefetchExternalScripts?: boolean;

  /** Pre-fetch `<link rel="modulepreload">` assets during harvest. @default `true` */
  prefetchModulePreloads?: boolean;

  /**
   * Controls whether non-critical third-party scripts (analytics, ads, chat
   * widgets) are executed.
   * - `"skip-noncritical"` — skip them (faster, less noise)
   * - `"execute-all"` — run everything
   * @default `"skip-noncritical"`
   */
  thirdPartyPolicy?: DynafetchThirdPartyPolicy;

  /**
   * Minimum time (ms) to wait before checking if the page is idle.
   * Increase if the site's scripts take a while to kick off their first
   * network request after boot.
   * @default 75
   */
  minWaitMs?: number;

  /**
   * How long (ms) the page must be completely idle (zero pending requests)
   * before we consider it settled. A shorter value returns faster but risks
   * missing late-firing requests.
   * @default 100
   */
  idleWaitMs?: number;

  /**
   * Hard upper bound (ms) on how long to wait for the page to settle.
   * After this, results are returned regardless of pending activity.
   * @default 2000
   */
  maxWaitMs?: number;

  /**
   * Maximum time (ms) to wait for ES module bundling (esbuild) to complete.
   * Only relevant for sites using `<script type="module">`.
   * @default 6000
   */
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
