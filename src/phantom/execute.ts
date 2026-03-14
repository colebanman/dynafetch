import { log, warn } from './log.ts';
import { JSDOM, VirtualConsole, CookieJar } from 'jsdom';
import WebSocket from 'ws';
import * as nodeCrypto from 'crypto';
import type { HarvestResult, ExecutionResult, NetworkLogEntry, ScriptAsset } from './types.ts';
import { Transformer } from './transform.ts';
import { phantomFetch } from './phantom-proxy.ts';
import type { ProxyRequest, ProxyResponse } from './phantom-proxy.ts';
import { chromeDocumentHeaders, chromeSubresourceHeaders } from './headers.ts';
import { compileMatcher, type CompiledMatcher } from './matcher.ts';
import { shouldSkipDynamicScriptUrl, shouldSkipScriptAsset, type ThirdPartyPolicy } from './script-policy.ts';

export interface QuiescenceOptions {
  minWaitMs?: number;
  idleWaitMs?: number;
  maxWaitMs?: number;
}

interface NormalizedProxy {
  url: string;
  scopes: Set<string>;
}

export interface ExecutorOptions {
  targetValue?: string | number | null;
  matcherRegex?: boolean;
  findAll?: boolean;  // false = early exit on first match (default, faster)
  fuzzyMatch?: boolean;  // true = case-insensitive matching (default)
  quiescence?: QuiescenceOptions;
  moduleWaitMs?: number;
  thirdPartyPolicy?: ThirdPartyPolicy;
  proxy?: NormalizedProxy;
  timeoutMs?: number;
  deadlineAt?: number;
}

type ExecutionError = {
  source: 'error' | 'unhandledrejection' | 'uncaughtException' | 'unhandledRejection';
  message: string;
  stack?: string;
};

export class Executor {
  private harvestData: HarvestResult;
  private transformer: Transformer;
  private logs: NetworkLogEntry[] = [];
  private targetValue: string | number | null = null;
  private matcherRegex: boolean = false;
  private compiledMatcher: CompiledMatcher | null = null;
  private scriptCache: Map<string, string> = new Map();
  private initialComponentName: string | null = null;
  private pendingRequests: number = 0;
  private pendingRequestNextId: number = 1;
  private pendingRequestMap = new Map<number, { url?: string; kind?: string; startedAt: number }>();
  private pendingTasks: number = 0;
  private pendingTaskNextId: number = 1;
  private pendingTaskTimers = new Map<number, NodeJS.Timeout>();
  private quiescenceResolver: (() => void) | null = null;
  private quiescenceTimer: NodeJS.Timeout | null = null;
  private quiescenceMaxTimer: NodeJS.Timeout | null = null;
  private quiescenceMinTimer: NodeJS.Timeout | null = null;
  private minifyBundle: boolean = false;

  // Module-script support (JSDOM does not execute <script type="module">).
  private handledModuleScriptUrls = new Set<string>();
  // JSDOM won't fetch/execute external scripts unless resources are enabled. We instead
  // intercept dynamic <script src="..."> insertions and fetch+eval them ourselves.
  private handledClassicScriptUrls = new Set<string>();
  private moduleBundleCache = new Map<string, string>(); // entryUrl -> transformed bundled JS
  private moduleResolveCache = new Map<string, { contents: string; loader: "js" | "ts" }>(); // url -> source
  private moduleInFlight = new Map<string, Promise<void>>(); // entryUrl -> promise
  private windowClosed: boolean = false;

  // Simple telemetry counters (useful for debugging).
  private telemetry_stubbed = 0;
  private telemetry_proxy = 0;
  private moduleWaitMs: number = 1500;
  private quiescenceOptions: Required<QuiescenceOptions> = {
    minWaitMs: 200,
    idleWaitMs: 250,
    maxWaitMs: 5000,
  };

  private timings = {
    transform_ms_total: 0,
    scripts_transformed_count: 0,
    quiescence_ms: 0,
  };

  private executionErrors: ExecutionError[] = [];
  private thirdPartyPolicy: ThirdPartyPolicy = 'skip-noncritical';
  private proxy?: NormalizedProxy;
  private timeoutMs?: number;
  private deadlineAt?: number;
  private warnings = new Set<string>();

  // Early exit tracking
  private findAll: boolean = false;
  private fuzzyMatch: boolean = true;
  private earlyMatches: NetworkLogEntry[] = [];
  private matchFound: boolean = false;
  
  constructor(harvestData: HarvestResult, options: ExecutorOptions | string | number | null = null) {
    this.harvestData = harvestData;
    this.transformer = new Transformer();
    
    // Support legacy signature: new Executor(data, targetValue)
    if (options === null || typeof options === 'string' || typeof options === 'number') {
      this.targetValue = options;
    } else {
      this.targetValue = options.targetValue ?? null;
      this.matcherRegex = options.matcherRegex === true;
      this.findAll = options.findAll ?? false;
      this.fuzzyMatch = options.fuzzyMatch ?? true;
      this.thirdPartyPolicy = options.thirdPartyPolicy ?? 'skip-noncritical';
      this.proxy = options.proxy;
      this.timeoutMs = options.timeoutMs;
      this.deadlineAt = options.deadlineAt;
      this.applyDefaults(options.quiescence, options.moduleWaitMs);
    }
    
    if (this.targetValue !== null && this.targetValue !== undefined) {
      const rawMatcher = String(this.targetValue);
      if (rawMatcher.length > 0) {
        this.compiledMatcher = compileMatcher({
          matcher: rawMatcher,
          matcherRegex: this.matcherRegex,
          fuzzyMatch: this.fuzzyMatch,
        });
      }
    }
    
    this.logs = [...harvestData.logs];
    this.initialComponentName = this.findInitialComponentName(harvestData.initialState);
    
    // Seed script cache with harvested external scripts
    this.harvestData.scripts.forEach(s => {
        if (s.url) {
            this.scriptCache.set(s.url, s.content);
        }
    });
    this.harvestData.modulePreloads?.forEach((asset) => {
      this.scriptCache.set(asset.url, asset.content);
      this.moduleResolveCache.set(asset.url, {
        contents: this.rewriteImportMeta(asset.content, asset.url),
        loader: asset.url.endsWith('.ts') || asset.url.endsWith('.tsx') ? 'ts' : 'js',
      });
    });
    // Merge the pre-warmed module graph from harvest into scriptCache
    this.harvestData.moduleGraphCache?.forEach((content, url) => {
      if (!this.scriptCache.has(url)) {
        this.scriptCache.set(url, content);
      }
    });
  }

  private clampMs(v: number, min: number, max: number): number {
    if (!Number.isFinite(v)) return min;
    return Math.max(min, Math.min(max, Math.trunc(v)));
  }

  private createTimeoutError(): Error {
    const timeoutMs = Math.max(1, Math.ceil(this.timeoutMs ?? 1));
    return new Error(`dynafetch timed out after ${timeoutMs}ms`);
  }

  private remainingTimeMs(): number | undefined {
    if (this.deadlineAt == null) return this.timeoutMs;
    const remaining = this.deadlineAt - Date.now();
    if (remaining <= 0) throw this.createTimeoutError();
    return Math.max(1, Math.ceil(remaining));
  }

  private boundedDurationMs(durationMs: number): number {
    if (this.deadlineAt == null) return durationMs;
    const remaining = this.deadlineAt - Date.now();
    if (remaining <= 0) return 0;
    return Math.max(0, Math.min(durationMs, Math.ceil(remaining)));
  }

  private recordWarning(warning?: string) {
    if (!warning) return;
    this.warnings.add(warning);
  }

  private applyDefaults(quiescence?: QuiescenceOptions, moduleWaitMsOverride?: number) {
    const hardMaxCap = this.clampMs(Number(process.env.PHANTOM_QUIESCENCE_MAX_CAP_MS ?? 8000), 500, 60_000);

    const minWaitMs = this.clampMs(quiescence?.minWaitMs ?? 75, 0, 10_000);
    const idleWaitMs = this.clampMs(quiescence?.idleWaitMs ?? 100, 0, 10_000);
    const maxWaitMs = this.clampMs(quiescence?.maxWaitMs ?? 2000, 0, hardMaxCap);

    const hardModuleCap = this.clampMs(Number(process.env.PHANTOM_MODULE_WAIT_MAX_CAP_MS ?? 30000), 1000, 120_000);
    this.moduleWaitMs = this.clampMs(Number(process.env.PHANTOM_MODULE_WAIT_MS ?? moduleWaitMsOverride ?? 6000), 1000, hardModuleCap);
    this.quiescenceOptions = { minWaitMs, idleWaitMs, maxWaitMs };
  }

  public logRequest(entry: NetworkLogEntry) {
      this.logs.push(entry);
      this.checkForMatch(entry);
  }
  
  private checkForMatch(entry: NetworkLogEntry): void {
      if (!this.compiledMatcher || (this.matchFound && !this.findAll)) return;

      const urlToCheck = entry.url ?? '';
      const bodyToCheck = typeof entry.responseBody === 'string' ? entry.responseBody : '';

      if (this.compiledMatcher.test(urlToCheck) || this.compiledMatcher.test(bodyToCheck)) {
          this.earlyMatches.push(entry);
          if (!this.findAll) {
              this.matchFound = true;
              this.triggerEarlyExit();
          }
      }
  }
  
  private triggerEarlyExit(): void {
      if (this.quiescenceResolver) {
          if (this.quiescenceTimer) {
              clearTimeout(this.quiescenceTimer);
              this.quiescenceTimer = null;
          }
          if (this.quiescenceMaxTimer) {
              clearTimeout(this.quiescenceMaxTimer);
              this.quiescenceMaxTimer = null;
          }
          if (this.quiescenceMinTimer) {
              clearTimeout(this.quiescenceMinTimer);
              this.quiescenceMinTimer = null;
          }
          this.quiescenceResolver();
          this.quiescenceResolver = null;
      }
  }

  private trackRequestStart(url?: string, kind?: string): number {
      const id = this.pendingRequestNextId++;
      this.pendingRequests++;
      this.pendingRequestMap.set(id, { url, kind, startedAt: Date.now() });
      if (this.quiescenceTimer) {
          clearTimeout(this.quiescenceTimer);
          this.quiescenceTimer = null;
      }
      return id;
  }

  private trackRequestEnd(id?: number) {
      this.pendingRequests = Math.max(0, this.pendingRequests - 1);
      if (typeof id === 'number') this.pendingRequestMap.delete(id);
      if ((this.pendingRequests + this.pendingTasks) === 0 && this.quiescenceResolver) {
          // Wait for an idle window before resolving
          this.quiescenceTimer = setTimeout(() => {
              if ((this.pendingRequests + this.pendingTasks) === 0 && this.quiescenceResolver) {
                  this.quiescenceResolver();
                  this.quiescenceResolver = null;
              }
          }, this.quiescenceOptions.idleWaitMs);
      }
  }

  private trackTaskStart(kind?: string, url?: string, maxBlockMs?: number): number {
      const id = this.pendingTaskNextId++;
      this.pendingTasks++;
      if (this.quiescenceTimer) {
          clearTimeout(this.quiescenceTimer);
          this.quiescenceTimer = null;
      }

      const ms = this.clampMs(Number(maxBlockMs ?? 0), 0, 60_000);
      if (ms > 0) {
          const t = setTimeout(() => this.trackTaskEnd(id), ms);
          this.pendingTaskTimers.set(id, t);
      }

      return id;
  }

  private trackTaskEnd(id: number) {
      const t = this.pendingTaskTimers.get(id);
      if (t) {
          clearTimeout(t);
          this.pendingTaskTimers.delete(id);
      }
      if (this.pendingTasks > 0) this.pendingTasks--;
      if ((this.pendingRequests + this.pendingTasks) === 0 && this.quiescenceResolver) {
          this.quiescenceTimer = setTimeout(() => {
              if ((this.pendingRequests + this.pendingTasks) === 0 && this.quiescenceResolver) {
                  this.quiescenceResolver();
                  this.quiescenceResolver = null;
              }
          }, this.quiescenceOptions.idleWaitMs);
      }
  }

  private waitForQuiescence(): Promise<void> {
      const { maxWaitMs, minWaitMs, idleWaitMs } = this.quiescenceOptions;
      return new Promise((resolve) => {
          const finish = () => {
              if (!this.quiescenceResolver) return;
              if (this.quiescenceTimer) clearTimeout(this.quiescenceTimer);
              if (this.quiescenceMaxTimer) clearTimeout(this.quiescenceMaxTimer);
              if (this.quiescenceMinTimer) clearTimeout(this.quiescenceMinTimer);
              this.quiescenceTimer = null;
              this.quiescenceMaxTimer = null;
              this.quiescenceMinTimer = null;
              this.quiescenceResolver = null;
              resolve();
          };

          this.quiescenceResolver = finish;

          // Check if we already found a match and should exit early
          if (this.matchFound && !this.findAll) {
              this.triggerEarlyExit();
              return;
          }

          this.quiescenceMinTimer = setTimeout(() => {
              if (!this.quiescenceResolver) return;
              if ((this.pendingRequests + this.pendingTasks) === 0) {
                  this.quiescenceTimer = setTimeout(() => {
                      if (this.quiescenceResolver) this.quiescenceResolver();
                  }, idleWaitMs);
              }
          }, minWaitMs);

          this.quiescenceMaxTimer = setTimeout(() => {
              if (this.quiescenceResolver) this.quiescenceResolver();
          }, maxWaitMs);
      });
  }

  private async waitForModuleWork(timeoutMs: number): Promise<void> {
    const pending = Array.from(this.moduleInFlight.values());
    if (!pending.length) return;

    const timeout = this.clampMs(this.boundedDurationMs(timeoutMs), 0, 60_000);
    if (timeout === 0) return;

    const all = Promise.allSettled(pending).then(() => {});
    await Promise.race([
      all,
      new Promise<void>((r) => setTimeout(r, timeout)),
    ]);
  }

  private proxyUrlForScope(scope: 'page' | 'api' | 'assets'): string | undefined {
    if (!this.proxy) return undefined;
    return this.proxy.scopes.has(scope) ? this.proxy.url : undefined;
  }

	  private async fetchViaProxy(url: string, method: string, headers: Record<string, string>, body: string, proxyScope: 'api' | 'assets' = 'api'): Promise<ProxyResponse> {
	      try {
	        this.telemetry_proxy++;
	        const payload: ProxyRequest = { method, url, headers, headerOrder: Object.keys(headers), body, proxy: this.proxyUrlForScope(proxyScope) };
	        const response = await phantomFetch(payload, {
            timeoutMs: this.remainingTimeMs(),
          }) as ProxyResponse;
          this.recordWarning(response.warning);
	        return response;
	      } catch (e: any) {
	          return { status: 0, body: e.message, headers: {}, error: e.message };
	      }
	  }

  private rewriteImportMeta(source: string, moduleUrl: string): string {
    const importMetaLiteral = `({ url: ${JSON.stringify(moduleUrl)}, env: { MODE: "production", PROD: true, DEV: false, SSR: false, BASE_URL: "/" }, hot: undefined })`;

    return source
      .replace(/\bimport\.meta\.url\b/g, JSON.stringify(moduleUrl))
      .replace(/\bimport\.meta\.env\.MODE\b/g, `"production"`)
      .replace(/\bimport\.meta\.env\.PROD\b/g, 'true')
      .replace(/\bimport\.meta\.env\.DEV\b/g, 'false')
      .replace(/\bimport\.meta\.env\.SSR\b/g, 'false')
      .replace(/\bimport\.meta\.env\.BASE_URL\b/g, `"/"`)
      .replace(/\bimport\.meta\.env\b/g, `${importMetaLiteral}.env`)
      .replace(/\bimport\.meta\b/g, importMetaLiteral);
  }

  private findInitialComponentName(initialState: Record<string, any>): string | null {
    for (const value of Object.values(initialState || {})) {
      if (value && typeof value === 'object' && typeof value.component === 'string') {
        return value.component;
      }
    }
    return null;
  }

  private findMatchingBraceIndex(source: string, startIndex: number): number {
    let depth = 0;
    let quote: '"' | "'" | '`' | null = null;
    let escaped = false;

    for (let i = startIndex; i < source.length; i++) {
      const ch = source[i];
      if (quote) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === quote) quote = null;
        continue;
      }

      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch as '"' | "'" | '`';
        continue;
      }
      if (ch === '{') {
        depth++;
        continue;
      }
      if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }

    return -1;
  }

  private extractObjectProperty(source: string, objectStart: number, objectEnd: number, key: string): string | null {
    const needle = `"${key}"`;
    const keyIndex = source.indexOf(needle, objectStart);
    if (keyIndex === -1 || keyIndex > objectEnd) return null;

    let colonIndex = keyIndex + needle.length;
    while (colonIndex < objectEnd && source[colonIndex] !== ':') colonIndex++;
    if (colonIndex >= objectEnd) return null;

    let i = colonIndex + 1;
    let parenDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    let quote: '"' | "'" | '`' | null = null;
    let escaped = false;

    for (; i < objectEnd; i++) {
      const ch = source[i];
      if (quote) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === quote) quote = null;
        continue;
      }

      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch as '"' | "'" | '`';
        continue;
      }
      if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth--;
      else if (ch === '[') bracketDepth++;
      else if (ch === ']') bracketDepth--;
      else if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth--;
      else if (ch === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        return source.slice(keyIndex, i).trim();
      }
    }

    return source.slice(keyIndex, objectEnd).trim();
  }

  private pruneComponentRegistrySource(source: string): string | null {
    if (!this.initialComponentName) return null;
    if (!source.includes(this.initialComponentName)) return null;

    const constMatch = source.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*\{/);
    if (!constMatch || constMatch.index == null) return null;
    const registryVar = constMatch[1];
    const objectStart = source.indexOf('{', constMatch.index);
    const objectEnd = this.findMatchingBraceIndex(source, objectStart);
    if (objectStart === -1 || objectEnd === -1) return null;

    const propertySource = this.extractObjectProperty(source, objectStart, objectEnd, this.initialComponentName);
    if (!propertySource) return null;

    const exportRegex = new RegExp(`export\\{\\s*${registryVar}\\s+as\\s+([A-Za-z_$][\\w$]*)\\s*\\}`);
    const exportMatch = source.match(exportRegex);
    if (!exportMatch || exportMatch.index == null) return null;

    const prefix = source.slice(0, constMatch.index);
    const suffix = source.slice(exportMatch.index);
    return `${prefix}const ${registryVar}={${propertySource}};${suffix}`;
  }

  private async handleModuleScript(
    entryUrl: string,
    window: any,
    options: { inlineSource?: string; cacheKey?: string } = {},
  ): Promise<void> {
    const cacheKey = options.cacheKey ?? entryUrl;
    const existing = this.moduleInFlight.get(cacheKey);
    if (existing) return existing;

	    const p = (async () => {
		      const taskId = this.trackTaskStart('module_bundle', cacheKey, this.boundedDurationMs(this.moduleWaitMs));
	      try {
	        if (process.env.PHANTOM_DEBUG_MODULES === '1') {
	          log('[Executor] Bundling module entry:', cacheKey);
	        }
        const cached = this.moduleBundleCache.get(cacheKey);
        if (cached) {
          if (!this.windowClosed) window.eval(cached);
          return;
        }

        const esbuildMod: any = await import('esbuild');
        const buildFn = esbuildMod?.build || esbuildMod?.default?.build;
        if (typeof buildFn !== 'function') {
          throw new Error('esbuild.build not available (esbuild import failed)');
        }

        const entry = new URL(entryUrl);
        const entryOrigin = entry.origin;

        const stripQueryHash = (u: string) => {
          try {
            const uu = new URL(u);
            return uu.pathname.toLowerCase();
          } catch {
            // Best-effort for odd inputs.
            return String(u).split('?')[0].split('#')[0].toLowerCase();
          }
        };

        const isStubAsset = (u: string) => {
          const p = stripQueryHash(u);
          return (
            p.endsWith('.css') ||
            p.endsWith('.png') ||
            p.endsWith('.jpg') ||
            p.endsWith('.jpeg') ||
            p.endsWith('.gif') ||
            p.endsWith('.webp') ||
            p.endsWith('.avif') ||
            p.endsWith('.svg') ||
            p.endsWith('.ico') ||
            p.endsWith('.woff') ||
            p.endsWith('.woff2') ||
            p.endsWith('.ttf') ||
            p.endsWith('.otf') ||
            p.endsWith('.eot') ||
            p.endsWith('.mp3') ||
            p.endsWith('.mp4') ||
            p.endsWith('.webm') ||
            p.endsWith('.mov') ||
            p.endsWith('.wasm')
          );
        };

        const getLoader = (u: string): "js" | "ts" => {
          const p = stripQueryHash(u);
          if (p.endsWith('.ts') || p.endsWith('.tsx')) return "ts";
          return "js";
        };

        const httpPlugin = {
          name: 'phantom-http-url',
          setup: (build: any) => {
            build.onResolve({ filter: /.*/ }, (args: any) => {
              const path = String(args.path || '');
              const importer = String(args.importer || '');

              // Ignore non-HTTP schemes (data:, blob:, etc); let esbuild handle or error.
              if (path.startsWith('data:') || path.startsWith('blob:') || path.startsWith('file:')) {
                return { path, external: true };
              }

              if (path.startsWith('http://') || path.startsWith('https://')) {
                return { path, namespace: 'http-url' };
              }

              const base = (() => {
                try {
                  if (importer.startsWith('http://') || importer.startsWith('https://')) return importer;
                } catch {}
                return entryUrl;
              })();

              try {
                if (path.startsWith('/')) {
                  const origin = (() => {
                    try { return new URL(base).origin; } catch { return entryOrigin; }
                  })();
                  return { path: new URL(path, origin).toString(), namespace: 'http-url' };
                }
                return { path: new URL(path, base).toString(), namespace: 'http-url' };
              } catch {
                // If URL construction fails, let esbuild try its normal resolver.
                return null;
              }
            });

            build.onLoad({ filter: /.*/, namespace: 'http-url' }, async (args: any) => {
              const url = String(args.path || '');

              if (isStubAsset(url)) {
                this.telemetry_stubbed++;
                return { contents: 'export default "";\n', loader: 'js' };
              }

              const cached = this.moduleResolveCache.get(url);
              if (cached) return cached;
              const prefetched = this.scriptCache.get(url);
              if (prefetched != null) {
                const pruned = /component_registry/i.test(url) ? this.pruneComponentRegistrySource(prefetched) : null;
                const entry = { contents: this.rewriteImportMeta(pruned ?? prefetched, url), loader: getLoader(url) };
                this.moduleResolveCache.set(url, entry);
                return entry;
              }

              const { headers: subHeaders } = chromeSubresourceHeaders(this.harvestData.url);

              // Align with our proxy TLS profile UA, and set a reasonable dest hint.
              subHeaders["sec-fetch-dest"] = "script";
              subHeaders["sec-fetch-mode"] = "cors";
              try {
                const pageOrigin = new URL(this.harvestData.url).origin;
                const reqOrigin = new URL(url).origin;
                subHeaders["sec-fetch-site"] = reqOrigin === pageOrigin ? "same-origin" : "cross-site";
              } catch {
                subHeaders["sec-fetch-site"] = "cross-site";
              }

              const resp = await this.fetchViaProxy(url, 'GET', subHeaders, '', 'assets');
              if (resp.error || resp.status >= 400) {
                throw new Error(resp.error || `Module fetch failed: ${resp.status} ${url}`);
              }

              const body = resp.body ?? '';
              const pruned = /component_registry/i.test(url) ? this.pruneComponentRegistrySource(body) : null;
              const entry = { contents: this.rewriteImportMeta(pruned ?? body, url), loader: getLoader(url) };
              this.moduleResolveCache.set(url, entry);
              return entry;
            });
          }
        };

        const result = await buildFn({
          bundle: true,
          write: false,
          format: 'iife',
          platform: 'browser',
          target: 'es2020',
          sourcemap: false,
          minify: this.minifyBundle,
          stdin: {
            contents: options.inlineSource
              ? this.rewriteImportMeta(options.inlineSource, entryUrl)
              : `import ${JSON.stringify(entryUrl)};\n`,
            sourcefile: entryUrl,
          },
          plugins: [httpPlugin],
        });

        const outputText = result?.outputFiles?.[0]?.text;
        if (!outputText) throw new Error('esbuild produced no output');

        const bundleIdHash = nodeCrypto.createHash('sha256').update(cacheKey).digest('hex').slice(0, 10);
        const transformed = this.transformer.transform(outputText, `module_bundle_${bundleIdHash}`);
        this.moduleBundleCache.set(cacheKey, transformed);

        if (!this.windowClosed) window.eval(transformed);
        if (process.env.PHANTOM_DEBUG_MODULES === '1') {
          log('[Executor] Module bundle eval complete:', cacheKey);
        }
	      } catch (e) {
	        this.recordExecutionError(e, 'unhandledRejection');
	      } finally {
	        this.trackTaskEnd(taskId);
	        this.moduleInFlight.delete(cacheKey);
	      }
	    })();

    this.moduleInFlight.set(cacheKey, p);
    return p;
  }

  private recordExecutionError(err: unknown, source: ExecutionError['source']) {
    const e = err instanceof Error ? err : new Error(String(err));
    this.executionErrors.push({ source, message: e.message, stack: e.stack });
  }

  private looksLikeESModule(code: string): boolean {
    return (
      /(^|[^\w$.])import(?:\s+[\w*{]|\s*["']|\()/m.test(code) ||
      /(^|[^\w$.])export\s+(?:\{|\*|default|const|function|class|let|var)\b/m.test(code) ||
      /\bimport\.meta\b/.test(code)
    );
  }

  private installWebPlatformShims(window: any) {
    const that = this;

    // Ensure common "global object" names resolve to the JSDOM window.
    try { window.globalThis = window; } catch {}
    try { window.self = window; } catch {}

    // Base64 helpers are widely used.
    if (!window.atob) {
      window.atob = (s: string) => Buffer.from(String(s), 'base64').toString('binary');
    }
    if (!window.btoa) {
      window.btoa = (s: string) => Buffer.from(String(s), 'binary').toString('base64');
    }

    // Route fetch through __phantom.fetch so we can capture requests without AST rewrites.
    if (window.__phantom?.fetch) {
      window.fetch = function fetchShim(input: any, init?: any) {
        return window.__phantom.fetch(input, init);
      };
    }

    // Prefer Node's built-in fetch primitives (Undici) when available.
    const g: any = globalThis as any;
    if (!window.Headers && g.Headers) window.Headers = g.Headers;
    if (!window.Request && g.Request) window.Request = g.Request;
    if (!window.Response && g.Response) window.Response = g.Response;
    if (!window.AbortController && g.AbortController) window.AbortController = g.AbortController;
    if (!window.AbortSignal && g.AbortSignal) window.AbortSignal = g.AbortSignal;
    if (!window.TextEncoder && g.TextEncoder) window.TextEncoder = g.TextEncoder;
    if (!window.TextDecoder && g.TextDecoder) window.TextDecoder = g.TextDecoder;
    if (!window.structuredClone && g.structuredClone) window.structuredClone = g.structuredClone.bind(g);

    const makeStorage = () => {
      const store = new Map<string, string>();
      return {
        get length() {
          return store.size;
        },
        clear() {
          store.clear();
        },
        getItem(key: string) {
          return store.has(String(key)) ? store.get(String(key)) ?? null : null;
        },
        key(index: number) {
          return Array.from(store.keys())[index] ?? null;
        },
        removeItem(key: string) {
          store.delete(String(key));
        },
        setItem(key: string, value: string) {
          store.set(String(key), String(value));
        },
      };
    };

    try {
      if (!window.localStorage) window.localStorage = makeStorage();
    } catch {
      window.localStorage = makeStorage();
    }
    try {
      if (!window.sessionStorage) window.sessionStorage = makeStorage();
    } catch {
      window.sessionStorage = makeStorage();
    }

    if (!window.StorageEvent) {
      window.StorageEvent = class StorageEvent extends window.Event {
        key: string | null;
        oldValue: string | null;
        newValue: string | null;
        storageArea: any;
        url: string;

        constructor(type: string, init: any = {}) {
          super(type, init);
          this.key = init.key ?? null;
          this.oldValue = init.oldValue ?? null;
          this.newValue = init.newValue ?? null;
          this.storageArea = init.storageArea ?? null;
          this.url = init.url ?? window.location.href;
        }
      } as any;
    }

    // crypto.getRandomValues for UUIDs/nonces.
    if (!window.crypto) window.crypto = {};
    if (!window.crypto.getRandomValues) {
      if (g.crypto && typeof g.crypto.getRandomValues === 'function') {
        window.crypto.getRandomValues = g.crypto.getRandomValues.bind(g.crypto);
      } else {
        window.crypto.getRandomValues = (arr: Uint8Array) => {
          const buf = nodeCrypto.randomBytes(arr.length);
          arr.set(buf);
          return arr;
        };
      }
    }

    // MessageChannel is used by React schedulers, streaming components, etc.
    // Node.js provides it globally since v15; expose it on window for scripts that expect it.
    {
      const _g: any = globalThis as any;
      if (!window.MessageChannel && _g.MessageChannel) window.MessageChannel = _g.MessageChannel;
      if (!window.MessagePort && _g.MessagePort) window.MessagePort = _g.MessagePort;
    }

    if (!window.requestIdleCallback) {
      window.requestIdleCallback = (cb: any) => window.setTimeout(() => cb({
        didTimeout: false,
        timeRemaining: () => 50,
      }), 1);
    }
    if (!window.cancelIdleCallback) {
      window.cancelIdleCallback = (id: any) => window.clearTimeout(id);
    }

    if (!window.ResizeObserver) {
      window.ResizeObserver = class ResizeObserver {
        private callback: any;
        constructor(callback: any) {
          this.callback = callback;
        }
        observe(target: any) {
          try {
            window.setTimeout(() => {
              const rect = typeof target?.getBoundingClientRect === 'function'
                ? target.getBoundingClientRect()
                : { width: window.innerWidth, height: window.innerHeight, top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
              this.callback?.([{ target, contentRect: rect, borderBoxSize: [], contentBoxSize: [] }], this);
            }, 0);
          } catch {}
        }
        unobserve() {}
        disconnect() {}
      } as any;
    }

    try {
      Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true });
      Object.defineProperty(window.navigator, 'languages', { value: ['en-US', 'en'], configurable: true });
      Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
      Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
      Object.defineProperty(window.navigator, 'webdriver', { value: false, configurable: true });
      Object.defineProperty(window.navigator, 'hardwareConcurrency', { value: 8, configurable: true });
      Object.defineProperty(window.navigator, 'deviceMemory', { value: 8, configurable: true });
    } catch {}

    try {
      Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
      Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
      Object.defineProperty(window, 'scrollX', { value: 0, writable: true, configurable: true });
      Object.defineProperty(window, 'scrollY', { value: 0, writable: true, configurable: true });
    } catch {}
    if (!window.screen) {
      window.screen = {
        width: 1440,
        height: 900,
        availWidth: 1440,
        availHeight: 900,
      };
    }
    if (!window.visualViewport) {
      window.visualViewport = {
        width: window.innerWidth,
        height: window.innerHeight,
        scale: 1,
        offsetLeft: 0,
        offsetTop: 0,
        pageLeft: 0,
        pageTop: 0,
        addEventListener() {},
        removeEventListener() {},
      };
    }
    if (!window.scrollTo) {
      window.scrollTo = (x: number, y: number) => {
        window.scrollX = typeof x === 'number' ? x : window.scrollX;
        window.scrollY = typeof y === 'number' ? y : window.scrollY;
      };
    }
    if (!window.scrollBy) {
      window.scrollBy = (x: number, y: number) => {
        window.scrollTo((window.scrollX || 0) + (Number(x) || 0), (window.scrollY || 0) + (Number(y) || 0));
      };
    }

    try {
      Object.defineProperty(window.document, 'visibilityState', { value: 'visible', configurable: true });
      Object.defineProperty(window.document, 'hidden', { value: false, configurable: true });
    } catch {}
    if (!window.document.hasFocus) {
      window.document.hasFocus = () => true;
    }
    if (!window.focus) {
      window.focus = () => {
        try { window.dispatchEvent(new window.Event('focus')); } catch {}
      };
    }
    if (!window.blur) {
      window.blur = () => {
        try { window.dispatchEvent(new window.Event('blur')); } catch {}
      };
    }

    // Wrap timers/microtasks so async exceptions don't crash the Node process.
    const wrapCb = (cb: any) => {
      if (typeof cb !== 'function') return cb;
      return function wrappedCallback(this: any, ...args: any[]) {
        try {
          return cb.apply(this, args);
        } catch (e) {
          that.recordExecutionError(e, 'uncaughtException');
        }
      };
    };
    const _setTimeout = window.setTimeout?.bind(window);
    const _setInterval = window.setInterval?.bind(window);
    if (_setTimeout) window.setTimeout = (cb: any, ms?: any, ...rest: any[]) => _setTimeout(wrapCb(cb), ms, ...rest);
    if (_setInterval) window.setInterval = (cb: any, ms?: any, ...rest: any[]) => _setInterval(wrapCb(cb), ms, ...rest);
    if (window.queueMicrotask) {
      const _q = window.queueMicrotask.bind(window);
      window.queueMicrotask = (cb: any) => _q(wrapCb(cb));
    }

    // Capture window-level errors for debugging and to avoid hard crashes.
    if (window.addEventListener) {
      window.addEventListener('error', (ev: any) => {
        that.recordExecutionError(ev?.error || ev?.message || ev, 'error');
        if (typeof ev?.preventDefault === 'function') ev.preventDefault();
      });
      window.addEventListener('unhandledrejection', (ev: any) => {
        that.recordExecutionError(ev?.reason || ev, 'unhandledrejection');
        if (typeof ev?.preventDefault === 'function') ev.preventDefault();
      });
    }

    // Track whether DOMContentLoaded has already been dispatched. Only replay
    // for listeners registered AFTER the dispatch — avoids double-firing during
    // the transition from 'loading' → 'interactive' where the explicit dispatch
    // at line ~1612 would also reach the same listener.
    let domContentLoadedDispatched = false;
    (window as any).__phantom_markDCLDispatched = () => { domContentLoadedDispatched = true; };

    if (window.document?.addEventListener) {
      const origDocAddEventListener = window.document.addEventListener.bind(window.document);
      window.document.addEventListener = function(type: string, listener: any, options?: any) {
        const result = origDocAddEventListener(type, listener, options);
        if (type === 'DOMContentLoaded' && domContentLoadedDispatched) {
          window.setTimeout(() => {
            try {
              if (typeof listener === 'function') {
                listener.call(window.document, new window.Event('DOMContentLoaded'));
              } else if (listener && typeof listener.handleEvent === 'function') {
                listener.handleEvent.call(listener, new window.Event('DOMContentLoaded'));
              }
            } catch (e) {
              that.recordExecutionError(e, 'error');
            }
          }, 0);
        }
        return result;
      };
    }

    // Canvas is not implemented by default in JSDOM. Many bundles (eg Lottie) assume a 2D context exists.
    // Provide a permissive mock context so animation/rendering code doesn't hard-crash execution.
    const makeCtx = () => {
      const noop = () => {};
      const base: any = {
        canvas: null,
        // Common methods used by renderers
        save: noop,
        restore: noop,
        beginPath: noop,
        closePath: noop,
        clip: noop,
        moveTo: noop,
        lineTo: noop,
        bezierCurveTo: noop,
        quadraticCurveTo: noop,
        rect: noop,
        arc: noop,
        fill: noop,
        stroke: noop,
        clearRect: noop,
        fillRect: noop,
        strokeRect: noop,
        drawImage: noop,
        translate: noop,
        rotate: noop,
        scale: noop,
        transform: noop,
        setTransform: noop,
        resetTransform: noop,
        measureText: (text: string) => ({ width: (String(text).length || 0) * 8 }),
        createLinearGradient: () => ({ addColorStop: noop }),
        createRadialGradient: () => ({ addColorStop: noop }),
        createPattern: () => ({}),
        getImageData: () => ({ data: new Uint8ClampedArray(0) }),
        putImageData: noop,
      };
      return new Proxy(base, {
        get(target, prop) {
          if (prop in target) return (target as any)[prop];
          // Return no-op functions for unknown methods.
          return noop;
        },
        set(target, prop, value) {
          (target as any)[prop] = value;
          return true;
        },
      });
    };

    if (window.HTMLCanvasElement && window.HTMLCanvasElement.prototype) {
      const proto = window.HTMLCanvasElement.prototype;
      const origGetContext = proto.getContext;
      proto.getContext = function(this: any, type: string, ...args: any[]) {
        try {
          const ctx = origGetContext ? origGetContext.call(this, type, ...args) : null;
          if (ctx) return ctx;
        } catch {}
        const mock = makeCtx();
        mock.canvas = this;
        return mock;
      };
    }
  }

  async execute(): Promise<ExecutionResult> {
    const onNodeUncaught = (err: unknown) => this.recordExecutionError(err, 'uncaughtException');
    const onNodeUnhandled = (reason: unknown) => this.recordExecutionError(reason, 'unhandledRejection');
    process.on('uncaughtException', onNodeUncaught);
    process.on('unhandledRejection', onNodeUnhandled);

    try {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("log", (...args) => log("[JSDOM Log]", ...args));
    virtualConsole.on("error", (...args) => console.error("[JSDOM Error]", ...args));
    virtualConsole.on("warn", (...args) => warn("[JSDOM Warn]", ...args));

    const cookieJar = new CookieJar();
    this.harvestData.cookies.forEach(c => {
        try { cookieJar.setCookieSync(c, this.harvestData.url); } catch (e) {}
    });

	    // Keep aligned with the active dynafetch-net TLS fingerprint and browser headers.
	    const DEFAULT_UA = chromeDocumentHeaders().headers["user-agent"];

	    const htmlWithDataOnly = this.stripExecutableScripts(this.harvestData.html);

	    const dom = new JSDOM(htmlWithDataOnly, {
	      url: this.harvestData.url,
	      referrer: "https://www.google.com/",
	      runScripts: "dangerously",
	      cookieJar,
	      virtualConsole,
	      beforeParse: (window) => {
	        // Make the UA deterministic and consistent with our proxy fingerprint.
	        try {
	          Object.defineProperty(window.navigator, "userAgent", {
	            value: DEFAULT_UA,
	            configurable: true,
	          });
	        } catch {}

	        // Polyfills for missing browser APIs
	        // IntersectionObserver: immediately report all observed elements as visible
	        // so lazy-loaded modules (chart, sparkline, etc.) get triggered.
	        window.IntersectionObserver = class IntersectionObserver {
	            _callback: any;
	            constructor(callback: any) { this._callback = callback; }
	            observe(target: any) {
	              try {
	                // Fire callback async so the caller finishes setup first
	                Promise.resolve().then(() => {
	                  this._callback?.([{ target, isIntersecting: true, intersectionRatio: 1 }], this);
	                });
	              } catch {}
	            }
            unobserve() {}
            disconnect() {}
            takeRecords() { return []; }
        };

	        window.matchMedia = window.matchMedia || function(query) {
	            return {
                matches: false,
                media: query,
                onchange: null,
                addListener: function() {},
                removeListener: function() {},
                addEventListener: function() {},
                removeEventListener: function() {},
                dispatchEvent: function() { return false; }
            };
        };
        
        // Extend performance with mark/measure if missing
        if (!window.performance) {
             (window as any).performance = {};
        }
        
        if (!window.performance.mark) {
            (window.performance as any).mark = (name: string) => {
                return { 
                    name, 
                    entryType: 'mark', 
                    startTime: Date.now(), 
                    duration: 0, 
                    toJSON: () => {} 
                };
            };
        }
        
        if (!window.performance.measure) {
            (window.performance as any).measure = (name: string, startMark: string, endMark: string) => {
                return { 
                    name, 
                    entryType: 'measure', 
                    startTime: Date.now(), 
                    duration: 0, 
                    toJSON: () => {} 
                };
            };
        }
        
        if (!window.performance.clearMarks) {
            (window.performance as any).clearMarks = () => {};
        }

	        if (!window.performance.clearMeasures) {
	            (window.performance as any).clearMeasures = () => {};
	        }

        if (!window.performance.getEntriesByName) {
            (window.performance as any).getEntriesByName = () => [];
        }

	        if (!window.performance.getEntriesByType) {
	            (window.performance as any).getEntriesByType = () => [];
	        }

	        // Some app code passes root-relative paths to URL(). Browsers require a base;
	        // default to the current document URL to avoid hard runtime failures in JSDOM.
	        if (window.URL) {
	          const NativeURL = window.URL;
	          const URLShim: any = function(input: any, base?: any) {
	            if (base === undefined && typeof input === 'string' && /^[/?#]/.test(input)) {
	              return new (NativeURL as any)(input, window.location.href);
	            }
	            return new (NativeURL as any)(input, base);
	          };
	          try { Object.setPrototypeOf(URLShim, NativeURL); } catch {}
	          URLShim.prototype = NativeURL.prototype;
	          (window as any).URL = URLShim;
	        }

        if (!window.requestAnimationFrame) {
            window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
        }

        if (!window.cancelAnimationFrame) {
            window.cancelAnimationFrame = (id) => window.clearTimeout(id);
        }

        if (!window.process) {
            (window as any).process = {
                env: { NODE_ENV: 'production' },
                version: '',
                nextTick: (cb: any) => window.setTimeout(cb, 0),
                browser: true
            };
        }

	        this.injectPhantom(window);
	        this.installWebPlatformShims(window);

	        // Hook runtime insertion of <script type="module" src="..."> so we can bundle+eval it.
        // Guard against double-wrapping in case beforeParse runs more than once.
        const HOOK_FLAG = '__phantomModuleScriptHookInstalled';
        if (!(window as any)[HOOK_FLAG]) {
          (window as any)[HOOK_FLAG] = true;
	            const that = this;
	            const NodeProto = (window as any).Node?.prototype;
              const syntheticLoadedLinks = new WeakSet<any>();
	            if (NodeProto) {
	              const origAppendChild = NodeProto.appendChild;
	              const origInsertBefore = NodeProto.insertBefore;

	              const maybeHandle = (node: any) => {
	                try {
	                  if (!node) return;
                    const synthesizeStylesheetLoad = (el: any) => {
                      const tag = String(el?.tagName || '').toLowerCase();
                      if (tag !== 'link') return;
                      const rel = String(el.rel || el.getAttribute?.('rel') || '').toLowerCase();
                      if (rel !== 'stylesheet') return;
                      if (syntheticLoadedLinks.has(el)) return;
                      syntheticLoadedLinks.add(el);

                      window.setTimeout(() => {
                        try {
                          const ev = new window.Event('load');
                          if (typeof el.onload === 'function') el.onload(ev);
                          if (typeof el.dispatchEvent === 'function') el.dispatchEvent(ev);
                        } catch {}
                      }, 0);
                    };

	                  const handleOne = (el: any) => {
	                    const tag = String(el?.tagName || '').toLowerCase();
                      if (tag === 'link') {
                        synthesizeStylesheetLoad(el);
                        return;
                      }
	                    if (tag !== 'script') return;

	                    const t = String((el.type || el.getAttribute?.('type') || '')).toLowerCase();
	                    const src = String(el.src || el.getAttribute?.('src') || '');
	                    if (!src) return;

	                    const abs = new URL(src, window.location.href).toString();
                      if (shouldSkipDynamicScriptUrl(abs, that.harvestData.url, that.thirdPartyPolicy)) {
                        return;
                      }

	                    if (t === 'module') {
	                      if (that.handledModuleScriptUrls.has(abs)) return;
	                      that.handledModuleScriptUrls.add(abs);
	                      if (process.env.PHANTOM_DEBUG_MODULES === '1') {
	                        log('[Executor] Detected module script:', abs);
	                      }
	                      void that.handleModuleScript(abs, window);
	                      return;
	                    }

	                    // Classic scripts: fetch+eval via proxy so we can keep logging and avoid jsdom resource loading.
	                    if (that.handledClassicScriptUrls.has(abs)) return;
	                    that.handledClassicScriptUrls.add(abs);
	                    const pendingId = that.trackRequestStart(abs, 'resource_load');
	                    const start = Date.now();
	                    const logEntry: NetworkLogEntry = {
	                      type: 'resource_load',
	                      url: abs,
	                      timestamp: start,
	                      initiator: 'Dynamic Script Loader',
	                    };
	                    that.logRequest(logEntry);

	                    const runClassic = async () => {
	                      try {
	                        // Cache hits avoid extra network and keep behavior stable.
	                        let code = that.scriptCache.get(abs);
	                        let headers: Record<string, string> = {};
	                        let status = 200;
	                        if (code == null) {
	                          const { headers: subHeaders } = chromeSubresourceHeaders(that.harvestData.url);
	                          subHeaders["user-agent"] = DEFAULT_UA;
	                          subHeaders["referer"] = window.location.href;
	                          const proxyResp = await that.fetchViaProxy(abs, 'GET', subHeaders, '', 'assets');
	                          status = proxyResp.status;
	                          headers = proxyResp.headers || {};
	                          code = proxyResp.status < 400 ? proxyResp.body : '';
	                          that.scriptCache.set(abs, code);
	                        }

	                        logEntry.status = status;
	                        logEntry.responseHeaders = headers;
	                        logEntry.responseBody = code;
	                        that.checkForMatch(logEntry);

	                        if (status >= 400) return;
                          if (code && that.looksLikeESModule(code)) {
                            that.handledModuleScriptUrls.add(abs);
                            await that.handleModuleScript(abs, window, { cacheKey: abs });
                            return;
                          }

	                        const t0 = Date.now();
	                        const transformed = that.transformer.transform(code, `dynamic_script_${nodeCrypto.createHash('sha256').update(abs).digest('hex').slice(0, 10)}`);
	                        that.timings.transform_ms_total += (Date.now() - t0);
	                        that.timings.scripts_transformed_count++;
	                        if (!that.windowClosed) window.eval(transformed);
	                      } catch (e) {
	                        that.recordExecutionError(e, 'error');
	                      } finally {
	                        that.trackRequestEnd(pendingId);
	                      }
	                    };

	                    void runClassic();
	                  };

	                  handleOne(node);
	                  if (typeof node.querySelectorAll === 'function') {
	                    const scripts = node.querySelectorAll('script[src]');
	                    for (const s of scripts) handleOne(s);
                      const stylesheets = node.querySelectorAll('link[rel="stylesheet"]');
                      for (const link of stylesheets) handleOne(link);
	                  }
	                } catch {}
	              };

            if (typeof origAppendChild === 'function') {
              NodeProto.appendChild = function(this: any, child: any) {
                maybeHandle(child);
                const ret = origAppendChild.call(this, child);
                return ret;
              };
            }

            if (typeof origInsertBefore === 'function') {
              NodeProto.insertBefore = function(this: any, newNode: any, refNode: any) {
                maybeHandle(newNode);
                const ret = origInsertBefore.call(this, newNode, refNode);
                return ret;
              };
            }

            // Fallback: observe DOM mutations so we also catch insertAdjacentHTML/innerHTML-driven insertions.
            if (typeof (window as any).MutationObserver === 'function' && window.document) {
              try {
                const obs = new (window as any).MutationObserver((mutations: any[]) => {
                  try {
                    for (const m of mutations) {
                      const added = m?.addedNodes;
                      if (!added) continue;
                      for (const n of Array.from(added)) maybeHandle(n);
                    }
                  } catch {}
                });
                obs.observe(window.document, { childList: true, subtree: true });
              } catch {}
            }
          }
        }
      }
    });

    const { window } = dom;
    let readyStateValue: 'loading' | 'interactive' | 'complete' = 'loading';
    try {
      Object.defineProperty(window.document, 'readyState', {
        configurable: true,
        get() {
          return readyStateValue;
        },
      });
    } catch {}
    const inertScriptPlaceholders = Array.from(
      window.document.querySelectorAll('script[type="application/x-phantom-script"]'),
    );
    const placeholderById = new Map<string, any>();
    const orderedScripts = [...this.harvestData.scripts].sort((a, b) => a.order - b.order);
    orderedScripts.forEach((script, index) => {
      placeholderById.set(script.id, inertScriptPlaceholders[index] ?? null);
    });

    const syncScripts = this.harvestData.scripts.filter(s => s.execution === 'sync');
    const deferScripts = this.harvestData.scripts.filter(s => s.execution === 'defer');
    const asyncScripts = this.harvestData.scripts.filter(s => s.execution === 'async');
    const currentScriptState: { value: any | null } = { value: null };
    try {
      Object.defineProperty(window.document, 'currentScript', {
        configurable: true,
        get() {
          return currentScriptState.value;
        },
      });
    } catch {}

    const shouldSkipScript = (script: ScriptAsset): boolean => {
        return shouldSkipScriptAsset(script, this.harvestData.url, this.thirdPartyPolicy);
    };

    const executeScript = async (script: ScriptAsset) => {
        if (shouldSkipScript(script)) return;
        if (script.type === 'external' && script.url) {
          if (script.scriptKind === 'module' && this.handledModuleScriptUrls.has(script.url)) return;
          if (script.scriptKind === 'classic' && this.handledClassicScriptUrls.has(script.url)) return;
        }

        const prevCurrentScript = currentScriptState.value;
        const scriptEl = placeholderById.get(script.id) || window.document.createElement('script');
        if (script.url) scriptEl.src = script.url;
        if (script.scriptKind === 'module') scriptEl.type = 'module';
        if (script.execution === 'async') scriptEl.async = true;
        if (script.execution === 'defer') scriptEl.defer = true;
        currentScriptState.value = scriptEl;

        if (script.scriptKind === 'module') {
          try {
            if (script.type === 'external' && script.url) {
              this.handledModuleScriptUrls.add(script.url);
              await this.handleModuleScript(script.url, window);
            } else {
              const inlineEntryUrl = new URL(`./__dynafetch_inline_module__/${script.id}.mjs`, this.harvestData.url).toString();
              await this.handleModuleScript(inlineEntryUrl, window, {
                inlineSource: script.content,
                cacheKey: `inline:${script.id}`,
              });
            }
          } catch (e) {
            warn(`[Executor] Module script ${script.id} failed:`, e);
          } finally {
            currentScriptState.value = prevCurrentScript;
          }
          return;
        }

        if (script.type === 'external' && script.url) {
          this.handledClassicScriptUrls.add(script.url);
        }

        const t0 = Date.now();
        const code = this.transformer.transform(script.content, script.id);
        this.timings.transform_ms_total += (Date.now() - t0);
        this.timings.scripts_transformed_count++;

        try {
            window.eval(code);
        } catch (e) {
            warn(`[Executor] Script ${script.id} failed:`, e);
        } finally {
            currentScriptState.value = prevCurrentScript;
        }
    };

    // Execute scripts sequentially (maintaining execution order)
    for (const s of syncScripts) {
      await executeScript(s);
      if (this.matchFound && !this.findAll) break;
    }

    // Run defer scripts — allow module work to proceed in parallel.
    {
      const deferWork = (async () => {
        for (const s of deferScripts) {
          await executeScript(s);
          if (this.matchFound && !this.findAll) break;
        }
      })();

      // Wait for both defer scripts and any pending module bundles concurrently.
      await Promise.all([deferWork, this.waitForModuleWork(this.moduleWaitMs)]);
    }

    readyStateValue = 'interactive';
    window.document.dispatchEvent(new window.Event('readystatechange'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    if (typeof (window as any).__phantom_markDCLDispatched === 'function') {
      (window as any).__phantom_markDCLDispatched();
    }
    window.document.dispatchEvent(new window.Event('visibilitychange'));

    // Fire all async scripts concurrently — mirrors real browser behavior.
    if (asyncScripts.length > 0) {
      await Promise.all(asyncScripts.map(s => executeScript(s).catch(() => {})));
    }

    // Only wait for module work if new modules were triggered by async scripts / events.
    if (this.moduleInFlight.size > 0) {
      await this.waitForModuleWork(this.moduleWaitMs);
    }

    readyStateValue = 'complete';
    window.document.dispatchEvent(new window.Event('readystatechange'));
	    window.dispatchEvent(new window.Event('load'));
    window.dispatchEvent(new window.Event('pageshow'));
    window.dispatchEvent(new window.Event('focus'));

    // Drain any module work spawned by load/pageshow handlers.
    if (this.moduleInFlight.size > 0) {
      await this.waitForModuleWork(this.moduleWaitMs);
    }

	    log('[Executor] Waiting for network quiescence...');
	    const quiescenceStart = Date.now();
	    try {
	        await this.waitForQuiescence();
	    } catch (e) {
        warn('[Executor] Quiescence wait failed:', e);
    }
    this.timings.quiescence_ms = Date.now() - quiescenceStart;
    const reason = this.matchFound && !this.findAll ? '(early exit on match)' : '';
	    log(`[Executor] Quiescence reached in ${Date.now() - quiescenceStart}ms ${reason}`);

      const renderedHtml = this.serializeDocument(window);

	    // Mark execution complete so any late dynamic loaders skip eval work.
	    this.windowClosed = true;
	    try { window.close(); } catch {}

	    const result: ExecutionResult = {
	      logs: this.logs,
	      matchedRequests: this.earlyMatches,
	      renderedHtml,
	      timings: { ...this.timings },
	      errors: this.executionErrors.length ? this.executionErrors : undefined,
        warnings: Array.from(this.warnings),
	    };

    // Give any just-scheduled microtasks/timers a brief window to run while our process-level
    // error handlers are still installed, so they get recorded instead of crashing the process.
    // Keep process-level handlers attached briefly to absorb late promise callbacks
    // that some third-party scripts schedule during teardown.
    const shutdownGraceMs = this.clampMs(Number(process.env.PHANTOM_SHUTDOWN_GRACE_MS ?? 50), 10, 5_000);
    await new Promise((r) => setTimeout(r, shutdownGraceMs));

    return result;

    } finally {
      process.off('uncaughtException', onNodeUncaught);
      process.off('unhandledRejection', onNodeUnhandled);
    }
  }

  private serializeDocument(window: any): string {
    try {
      const doctype = window.document?.doctype;
      const serializedDoctype = doctype
        ? `<!DOCTYPE ${doctype.name}${doctype.publicId ? ` PUBLIC "${doctype.publicId}"` : ''}${doctype.systemId ? ` "${doctype.systemId}"` : ''}>`
        : '';
      const html = window.document?.documentElement?.outerHTML ?? '';
      return `${serializedDoctype}${html}`;
    } catch {
      return this.harvestData.html;
    }
  }

  private stripExecutableScripts(html: string): string {
    return html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gim, (match, attrs, content) => {
        const isDataScript = attrs.includes('type="application/json"') || 
                           attrs.includes("type='application/json'") ||
                           attrs.includes('type="application/ld+json"') ||
                           attrs.includes('id="__ACGH_DATA__"'); 

        if (isDataScript) return match;
        const inertAttrs = attrs.replace(/\btype\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '').trim();
        return `<script type="application/x-phantom-script"${inertAttrs ? ` ${inertAttrs}` : ''}></script>`;
    });
  }

  private injectPhantom(window: any) {
    const that = this;

    const headersToObject = (h: any): Record<string, string> => {
      if (!h) return {};
      if (typeof h.forEach === 'function') {
        const out: Record<string, string> = {};
        try {
          h.forEach((v: any, k: any) => { out[String(k)] = String(v); });
          return out;
        } catch {}
      }
      if (typeof h.entries === 'function') {
        const out: Record<string, string> = {};
        try {
          for (const [k, v] of h.entries()) out[String(k)] = String(v);
          return out;
        } catch {}
      }
      if (typeof h === 'object') {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(h)) {
          if (v === undefined || v === null) continue;
          out[String(k)] = Array.isArray(v) ? String(v[0]) : String(v);
        }
        return out;
      }
      return {};
    };

    const normalizeFetchInput = async (input: any, opts: any) => {
      let url = input;
      let method = opts?.method || 'GET';
      let headers = headersToObject(opts?.headers);
      let body = opts?.body;

      const isRequestLike =
        input && typeof input === 'object' &&
        (typeof input.url === 'string' || typeof input.href === 'string') &&
        (typeof input.method === 'string' || typeof input.headers === 'object' || typeof input.headers?.forEach === 'function');

      if (isRequestLike) {
        url = input.url || input.href;
        method = opts?.method || input.method || method;
        headers = { ...headersToObject(input.headers), ...headers };
        if (body === undefined) {
          try {
            if (typeof input.text === 'function') body = await input.text();
          } catch {}
        }
      }

      const fullUrl = new URL(String(url), window.location.href).toString();
      return { url: fullUrl, method, headers, body };
    };

    const toSafeResponseHeaders = (rawHeaders: Record<string, string> | undefined) => {
      const H = window.Headers || (global as any).Headers;
      if (typeof H !== 'function') return rawHeaders ?? {};

      const safe = new H();
      if (!rawHeaders) return safe;

      for (const [k, v] of Object.entries(rawHeaders)) {
        if (v == null) continue;
        // Some proxy/backends fold long headers across lines. Undici rejects raw CR/LF in values.
        const value = String(v).replace(/[\r\n]+/g, ', ').trim();
        if (!value) continue;
        try {
          safe.set(k, value);
        } catch {
          // Ignore invalid header names/values to keep execution moving.
        }
      }

      return safe;
    };
    
    window.__phantom = {
      fetch: async (input: any, opts: any = {}) => {
        const norm = await normalizeFetchInput(input, opts);
        const start = Date.now();
        const headers = {
          'User-Agent': window.navigator.userAgent,
          'Cookie': window.document.cookie,
          'Referer': window.location.href,
          ...norm.headers,
        };

        const logEntry: NetworkLogEntry = {
          type: 'fetch',
          method: norm.method || 'GET',
          url: norm.url,
          requestHeaders: headers,
          requestBody: norm.body,
          timestamp: start
        };
        this.logRequest(logEntry);
        
        const pendingId = that.trackRequestStart(norm.url, 'fetch');
        try {
          const bodyStr = norm.body == null ? '' : (typeof norm.body === 'string' ? norm.body : String(norm.body));
          const proxyResp = await that.fetchViaProxy(norm.url, norm.method || 'GET', headers, bodyStr);
          if (proxyResp.error) throw new Error(proxyResp.error);

          logEntry.status = proxyResp.status;
          logEntry.responseBody = proxyResp.body;
          logEntry.responseHeaders = proxyResp.headers;
          this.checkForMatch(logEntry);
          
          return new (window.Response || (global as any).Response)(proxyResp.body, {
            status: proxyResp.status,
            headers: toSafeResponseHeaders(proxyResp.headers)
          });
        } catch (e: any) {
           logEntry.status = 0;
           logEntry.responseBody = e.message;
           this.checkForMatch(logEntry);
           throw e;
        } finally {
           that.trackRequestEnd(pendingId);
        }
      },

      WebSocket: class extends WebSocket {
         constructor(url: string, protocols?: string | string[]) {
             super(url, protocols);
             that.logRequest({ type: 'websocket', url: url, timestamp: Date.now() });
         }
      },

      EventSource: class {
        url: string;
        readyState: number = 0; // 0=CONNECTING, 1=OPEN, 2=CLOSED
        onopen: ((ev?: any) => void) | null = null;
        onmessage: ((ev?: any) => void) | null = null;
        onerror: ((ev?: any) => void) | null = null;
        private listeners: Map<string, Set<(ev: any) => void>> = new Map();

        constructor(url: string) {
          this.url = new URL(String(url), window.location.href).toString();
          that.logRequest({ type: 'eventsource', url: this.url, timestamp: Date.now() });
          this.readyState = 1;
          window.setTimeout(() => {
            try {
              this.onopen?.({ type: 'open' });
              this.listeners.get('open')?.forEach(fn => fn({ type: 'open' }));
            } catch (e) {
              that.recordExecutionError(e, 'error');
            }
          }, 0);
        }

        addEventListener(type: string, cb: (ev: any) => void) {
          if (!this.listeners.has(type)) this.listeners.set(type, new Set());
          this.listeners.get(type)!.add(cb);
        }

        removeEventListener(type: string, cb: (ev: any) => void) {
          this.listeners.get(type)?.delete(cb);
        }

        close() {
          this.readyState = 2;
        }
      },
      
      dynamicImport: async (url: string) => {
         const fullUrl = new URL(url, window.location.href).toString();
         const start = Date.now();
         const logEntry: NetworkLogEntry = { 
             type: 'dynamic_import', 
             url: fullUrl, 
             timestamp: start,
             initiator: 'dynamicImport'
         };
         this.logRequest(logEntry);

          const pendingId = that.trackRequestStart(fullUrl, 'dynamic_import');
          try {
            let code = that.scriptCache.get(fullUrl);
            let responseHeaders: Record<string, string> | undefined;
            let status = 200;

            if (code == null) {
              const proxyResp = await that.fetchViaProxy(fullUrl, 'GET', {
                'User-Agent': window.navigator.userAgent,
                'Cookie': window.document.cookie,
                'Referer': window.location.href
              }, '', 'assets');
              responseHeaders = proxyResp.headers;
              status = proxyResp.status;

              if (proxyResp.error || proxyResp.status >= 400) {
                logEntry.status = status;
                logEntry.responseHeaders = responseHeaders;
                logEntry.responseBody = null;
                this.checkForMatch(logEntry);
                throw new Error(proxyResp.error || `Status ${proxyResp.status}`);
              }

              code = proxyResp.body;
              that.scriptCache.set(fullUrl, code);
            }

            logEntry.status = status;
            logEntry.responseHeaders = responseHeaders;
            logEntry.responseBody = code;
            this.checkForMatch(logEntry);

            that.handledModuleScriptUrls.add(fullUrl);
            await that.handleModuleScript(fullUrl, window, {
              cacheKey: `dynamic:${fullUrl}`,
            });
            return {};
          } finally {
            that.trackRequestEnd(pendingId);
          }
      },

      XMLHttpRequest: class {
          readyState: number = 0;
          status: number = 0;
          statusText: string = '';
          responseText: string = '';
          response: any = null;
          responseType: '' | 'text' | 'json' = '';
          responseURL: string = '';
          timeout: number = 0;
          withCredentials: boolean = false;
          onreadystatechange: ((ev?: any) => void) | null = null;
          onload: ((ev?: any) => void) | null = null;
          onloadend: ((ev?: any) => void) | null = null;
          onerror: ((ev?: any) => void) | null = null;
          onprogress: ((ev?: any) => void) | null = null;
          onabort: ((ev?: any) => void) | null = null;
          ontimeout: ((ev?: any) => void) | null = null;

          private method: string = 'GET';
          private url: string = '';
          private asyncFlag: boolean = true;
          private requestHeaders: Record<string, string> = {};
          private responseHeaders: Record<string, string> = {};
          private aborted: boolean = false;

          open(method: string, url: string, async: boolean = true) {
              this.method = String(method || 'GET').toUpperCase();
              this.url = new URL(String(url), window.location.href).toString();
              this.asyncFlag = async !== false;
              this.aborted = false;
              if (process.env.PHANTOM_DEBUG_XHR === '1') {
                log('[XHR open]', this.method, this.url);
              }
              this.readyState = 1;
              this.responseURL = this.url;
              this.onreadystatechange?.({ type: 'readystatechange' });
          }

          setRequestHeader(k: string, v: string) {
              this.requestHeaders[String(k)] = String(v);
          }

          addEventListener(type: string, cb: any) {
              // Minimal compatibility: map common events to handler props if present.
              if (type === 'load') this.onload = cb;
              if (type === 'error') this.onerror = cb;
              if (type === 'readystatechange') this.onreadystatechange = cb;
              if (type === 'progress') this.onprogress = cb;
              if (type === 'loadend') this.onloadend = cb;
              if (type === 'abort') this.onabort = cb;
              if (type === 'timeout') this.ontimeout = cb;
          }

          getAllResponseHeaders() {
              return Object.entries(this.responseHeaders)
                  .map(([k, v]) => `${k}: ${v}\r\n`)
                  .join('');
          }

          getResponseHeader(name: string) {
              const n = String(name || '').toLowerCase();
              for (const [k, v] of Object.entries(this.responseHeaders)) {
                  if (k.toLowerCase() === n) return v;
              }
              return null;
          }

          abort() {
              this.aborted = true;
              this.readyState = 0;
              this.onabort?.({ type: 'abort' });
              this.onloadend?.({ type: 'loadend' });
          }

          async send(body?: any) {
              const start = Date.now();
              const headers = {
                  'User-Agent': window.navigator.userAgent,
                  'Cookie': window.document.cookie,
                  'Referer': window.location.href,
                  ...this.requestHeaders,
              };

              const logEntry: NetworkLogEntry = {
                  type: 'xhr',
                  method: this.method,
                  url: this.url,
                  requestHeaders: headers,
                  requestBody: body == null ? null : (typeof body === 'string' ? body : String(body)),
                  timestamp: start,
              };
              that.logRequest(logEntry);
              if (process.env.PHANTOM_DEBUG_XHR === '1') {
                log('[XHR send]', this.method, this.url, {
                  hasBody: body != null,
                  headers,
                });
              }

	              const doWork = async () => {
	                  const pendingId = that.trackRequestStart(this.url, 'xhr');
	                  try {
                      if (this.aborted) return;
                      const proxyResp = await that.fetchViaProxy(this.url, this.method, headers, (logEntry.requestBody as any) || '');
                      if (proxyResp.error) throw new Error(proxyResp.error);

                      this.responseHeaders = proxyResp.headers || {};
                      this.status = proxyResp.status;
                      this.statusText = proxyResp.status >= 200 && proxyResp.status < 300 ? 'OK' : '';
                      this.readyState = 2;
                      this.onreadystatechange?.({ type: 'readystatechange' });
                      this.responseText = proxyResp.body ?? '';
                      this.readyState = 3;
                      this.onprogress?.({ type: 'progress', loaded: this.responseText.length, total: this.responseText.length, lengthComputable: true });
                      this.onreadystatechange?.({ type: 'readystatechange' });
                      this.readyState = 4;
                      this.response = this.responseType === 'json'
                        ? (() => { try { return JSON.parse(this.responseText); } catch { return null; } })()
                        : this.responseText;

                      logEntry.status = proxyResp.status;
                      logEntry.responseHeaders = proxyResp.headers;
                      logEntry.responseBody = proxyResp.body;
                      that.checkForMatch(logEntry);

                      this.onreadystatechange?.({ type: 'readystatechange' });
                      this.onload?.({ type: 'load' });
                      this.onloadend?.({ type: 'loadend' });
                  } catch (e: any) {
                      this.readyState = 4;
                      this.status = 0;
                      logEntry.status = 0;
                      logEntry.responseBody = e?.message || String(e);
                      that.checkForMatch(logEntry);
                      this.onreadystatechange?.({ type: 'readystatechange' });
                      this.onerror?.({ type: 'error', error: e });
                      this.onloadend?.({ type: 'loadend' });
	                  } finally {
	                      that.trackRequestEnd(pendingId);
	                  }
	              };

              if (this.asyncFlag) {
                  window.setTimeout(() => { void doWork(); }, 0);
              } else {
                  await doWork();
              }
          }
      }
    };

    // Also expose on window for code paths that reference these directly (not via AST rewrite).
    window.XMLHttpRequest = window.__phantom.XMLHttpRequest;
    window.EventSource = window.__phantom.EventSource;
    window.WebSocket = window.__phantom.WebSocket;
  }
}
