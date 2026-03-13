import { log, warn } from './log.ts';
import * as cheerio from 'cheerio';
import type { HarvestResult, ScriptAsset, NetworkLogEntry } from './types.ts';
import { phantomFetch, phantomBatchFetch } from './phantom-proxy.ts';
import type { ProxyRequest, ProxyResponse } from './phantom-proxy.ts';
import { chromeDocumentHeaders } from './headers.ts';
import { BlockedByBotProtectionError } from './errors.ts';
import { classifyScriptAsset, shouldSkipScriptAsset, type ThirdPartyPolicy } from './script-policy.ts';
import { prefetchModuleGraph } from './module-prefetch.ts';

const { headers: DEFAULT_HEADERS, order: DEFAULT_HEADER_ORDER } = chromeDocumentHeaders();

export interface NormalizedProxy {
  url: string;
  scopes: Set<string>;
}

export interface HarvesterOptions {
  prefetchExternalScripts?: boolean;
  prefetchModulePreloads?: boolean;
  externalScriptConcurrency?: number;
  requestHeaders?: Record<string, string>;
  initialCookies?: string[];
  thirdPartyPolicy?: ThirdPartyPolicy;
  proxy?: NormalizedProxy;
}

async function runWithLimit<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;

  const workers = new Array(Math.max(1, limit)).fill(null).map(async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) break;
      results[i] = await tasks[i]();
    }
  });

  await Promise.all(workers);
  return results;
}

export class Harvester {
  private targetUrl: string;
  private cookies: string[] = [];
  private logs: NetworkLogEntry[] = [];
  private prefetchExternalScripts: boolean = true;
  private externalScriptConcurrency: number = 8;
  private requestHeaders: Record<string, string> = {};
  private thirdPartyPolicy: ThirdPartyPolicy = 'skip-noncritical';
  private prefetchModulePreloads: boolean = true;
  private proxy?: NormalizedProxy;

  constructor(url: string, opts: HarvesterOptions = {}) {
    this.targetUrl = url;
    this.prefetchExternalScripts = opts.prefetchExternalScripts !== false;
    this.externalScriptConcurrency = opts.externalScriptConcurrency ?? 8;
    this.requestHeaders = opts.requestHeaders ?? {};
    this.cookies = [...(opts.initialCookies ?? [])];
    this.thirdPartyPolicy = opts.thirdPartyPolicy ?? 'skip-noncritical';
    this.prefetchModulePreloads = opts.prefetchModulePreloads !== false;
    this.proxy = opts.proxy;
  }

  private proxyUrlForScope(scope: 'page' | 'api' | 'assets'): string | undefined {
    if (!this.proxy) return undefined;
    return this.proxy.scopes.has(scope) ? this.proxy.url : undefined;
  }

  private buildCookieHeader(): string {
    const pairs: string[] = [];
    for (const raw of this.cookies) {
      // Each Set-Cookie may contain multiple newline-separated values
      for (const single of raw.split('\n')) {
        const nameVal = single.split(';')[0]?.trim();
        if (nameVal && nameVal.includes('=')) pairs.push(nameVal);
      }
    }
    return pairs.join('; ');
  }

  private async fetchViaProxy(
    url: string,
    headers: Record<string, string> = {},
    followRedirects: boolean = false,
    maxRedirects: number = 5,
    method: string = 'GET',
    body: string = '',
    proxyScope: 'page' | 'api' | 'assets' = 'page',
  ): Promise<{ status: number; body: string; headers: Record<string, string>; finalUrl: string }> {
    let currentUrl = url;
    let redirectCount = 0;
    let currentMethod = method;
    let currentBody = body;

    while (true) {
      try {
        // Inject accumulated cookies into request headers
        const cookieHeader = this.buildCookieHeader();
        const reqHeaders = { ...headers };
        if (cookieHeader) {
          reqHeaders['Cookie'] = cookieHeader;
        }

        const payload: ProxyRequest = {
          method: currentMethod,
          url: currentUrl,
          headers: reqHeaders,
          headerOrder: DEFAULT_HEADER_ORDER,
          body: currentBody,
          proxy: this.proxyUrlForScope(proxyScope),
        };

        const data = await phantomFetch(payload) as ProxyResponse;
        if (data.error) throw new Error(`Proxy Error: ${data.error}`);

        // Collect cookies from every response
        const setCookie = data.headers['Set-Cookie'] || data.headers['set-cookie'];
        if (setCookie) this.cookies.push(setCookie);

        if (followRedirects && data.status >= 300 && data.status < 400 && redirectCount < maxRedirects) {
          const location = data.headers['Location'] || data.headers['location'];
          if (location) {
            currentUrl = new URL(location, currentUrl).toString();
            log(`[Harvest] Following redirect to: ${currentUrl}`);
            redirectCount++;
            // Per HTTP spec: 302/303 redirects reset method to GET
            if (data.status === 302 || data.status === 303) {
              currentMethod = 'GET';
              currentBody = '';
            }
            continue;
          }
        }

        return { ...data, finalUrl: currentUrl };
      } catch (e) {
        console.error(`[Harvester] Proxy request failed for ${currentUrl}:`, e);
        throw e;
      }
    }
  }

  private isConsentWall(url: string, html: string): boolean {
    // High-confidence: URL is on a known consent domain
    const consentDomains = ['consent.yahoo.com', 'guce.yahoo.com', 'consent.google.com', 'consent.youtube.com'];
    try {
      const hostname = new URL(url).hostname;
      if (consentDomains.some(d => hostname.includes(d))) return true;
    } catch {}
    // HTML heuristic: require a dedicated consent form (class or hidden sessionId/csrfToken),
    // not just any page that mentions consent in a cookie banner
    const $ = cheerio.load(html);
    const hasConsentForm = $('form.consent-form').length > 0
      || $('form').filter((_, el) => {
           const $f = $(el);
           return $f.find('input[name="csrfToken"]').length > 0
             && $f.find('input[name="sessionId"]').length > 0;
         }).length > 0;
    return hasConsentForm;
  }

  private parseConsentForm(html: string, baseUrl: string): { action: string; fields: Record<string, string> } | null {
    try {
      const $ = cheerio.load(html);
      // Find the form — prefer one with an agree/accept button
      let $form = $('form').filter((_, el) => {
        const text = $(el).text().toLowerCase();
        return text.includes('agree') || text.includes('accept') || text.includes('consent');
      }).first();
      if (!$form.length) $form = $('form').first();
      if (!$form.length) return null;

      const action = $form.attr('action');
      // Empty action means POST to the current page URL
      const absoluteAction = (action === undefined || action === null)
        ? null
        : (action === '' ? baseUrl : new URL(action, baseUrl).toString());
      if (!absoluteAction) return null;

      const fields: Record<string, string> = {};
      $form.find('input[type="hidden"]').each((_, el) => {
        const name = $(el).attr('name');
        const value = $(el).attr('value') ?? '';
        if (name) fields[name] = value;
      });

      // Add an agree field — different consent walls use different names
      const agreeBtn = $form.find('button[name], input[type="submit"][name]').filter((_, el) => {
        const text = ($(el).text() + ' ' + ($(el).attr('value') ?? '')).toLowerCase();
        return text.includes('agree') || text.includes('accept') || text.includes('consent');
      }).first();
      if (agreeBtn.length) {
        const name = agreeBtn.attr('name');
        const value = agreeBtn.attr('value') ?? 'agree';
        if (name) fields[name] = value;
      } else {
        fields['agree'] = 'agree';
      }

      return { action: absoluteAction, fields };
    } catch {
      return null;
    }
  }

  private looksBlocked(status: number, body: string): boolean {
    if (status !== 403 && status !== 429 && status !== 503 && status !== 999) return false;
    const b = (body || '').toLowerCase();
    if (status === 999) return true;
    return (
      b.includes('just a moment') ||
      b.includes('challenge-platform') ||
      b.includes('__cf_chl') ||
      b.includes('cf-browser-verification') ||
      b.includes('enable javascript and cookies to continue') ||
      b.includes('security verification') ||
      b.includes('captcha') ||
      b.includes('trkcode=') ||
      b.includes('trkinfo=')
    );
  }

  async harvest(): Promise<HarvestResult> {
    log(`[Harvest] Fetching ${this.targetUrl} via TLS Proxy...`);
    let response = await this.fetchViaProxy(this.targetUrl, { ...DEFAULT_HEADERS, ...this.requestHeaders }, true);

    if (response.status >= 400) {
      log(`[Harvest] Response Body on Error:`, response.body.substring(0, 500));
      if (this.looksBlocked(response.status, response.body || '')) {
        throw new BlockedByBotProtectionError(
          this.targetUrl,
          `Site is blocked by bot protection (HTTP ${response.status}) and cannot be fetched from this environment: ${this.targetUrl}`,
        );
      }
      throw new Error(`Failed to fetch ${this.targetUrl}: ${response.status}`);
    }

    let finalUrl = response.finalUrl;
    let html = response.body;

    // --- Consent wall bypass ---
    if (this.isConsentWall(finalUrl, html)) {
      log(`[Harvest] Consent wall detected at ${finalUrl}, attempting bypass...`);
      const form = this.parseConsentForm(html, finalUrl);
      if (form) {
        try {
          const formBody = new URLSearchParams(form.fields).toString();
          const postHeaders = {
            ...DEFAULT_HEADERS,
            ...this.requestHeaders,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': finalUrl,
            'Origin': new URL(finalUrl).origin,
          };
          const consentResp = await this.fetchViaProxy(form.action, postHeaders, true, 10, 'POST', formBody);
          if (consentResp.status < 400) {
            log(`[Harvest] Consent POST succeeded (${consentResp.status}), final URL: ${consentResp.finalUrl}`);
            // The POST redirect chain often lands directly on the real page — use it if so
            if (!this.isConsentWall(consentResp.finalUrl, consentResp.body)) {
              response = consentResp;
              finalUrl = consentResp.finalUrl;
              html = consentResp.body;
              log(`[Harvest] Consent bypass successful (from redirect), got real page at ${finalUrl}`);
            } else {
              // Redirect didn't land on the real page — re-fetch the original URL with consent cookies
              log(`[Harvest] Consent redirect still on consent page, re-fetching original URL...`);
              const retryResp = await this.fetchViaProxy(this.targetUrl, { ...DEFAULT_HEADERS, ...this.requestHeaders }, true);
              if (retryResp.status < 400 && !this.isConsentWall(retryResp.finalUrl, retryResp.body)) {
                response = retryResp;
                finalUrl = retryResp.finalUrl;
                html = retryResp.body;
                log(`[Harvest] Consent bypass successful (re-fetch), got real page at ${finalUrl}`);
              } else {
                warn(`[Harvest] Re-fetch after consent still returned consent wall, proceeding with original`);
              }
            }
          } else {
            warn(`[Harvest] Consent POST returned ${consentResp.status}, proceeding with consent page`);
          }
        } catch (e) {
          warn(`[Harvest] Consent bypass failed, proceeding with consent page:`, e);
        }
      } else {
        warn(`[Harvest] Could not parse consent form, proceeding with consent page`);
      }
    }

    const $ = cheerio.load(html);
    const scriptAssets: ScriptAsset[] = [];
    const modulePreloads: Array<{ url: string; content: string }> = [];
    const scriptTags = $('script');
    let skippedScriptCount = 0;
    
    // Collect metadata for batch-fetching external scripts
    const fetchTasks: Array<() => Promise<void>> = [];
    const batchScriptMeta: Array<{
      absoluteUrl: string;
      id: string;
      scriptKind: ScriptAsset['scriptKind'];
      category: ScriptAsset['category'];
      order: number;
      execution: ScriptAsset['execution'];
      headers: Record<string, string>;
    }> = [];
    let scriptCounter = 0;
    const seenModulePreloads = new Set<string>();

    for (let i = 0; i < scriptTags.length; i++) {
      const el = scriptTags[i];
      const $el = $(el);
      const src = $el.attr('src');
      const content = $el.html();
      const type = ($el.attr('type') || '').trim().toLowerCase();
      const isDefer = $el.attr('defer') !== undefined;
      const isAsync = $el.attr('async') !== undefined;
      const scriptKind: ScriptAsset['scriptKind'] = type === 'module' ? 'module' : 'classic';
      
      let execution: 'sync' | 'defer' | 'async' = 'sync';
      if (scriptKind === 'module') {
        execution = isAsync ? 'async' : 'defer';
      } else {
        if (isDefer) execution = 'defer';
        if (isAsync) execution = 'async';
      }

      if (type && type !== 'text/javascript' && type !== 'application/javascript' && type !== 'module' && !type.includes('json')) continue;
      if (type && (type === 'application/json' || type === 'application/ld+json')) continue;

      const order = i;
      const id = `script_${scriptCounter++}`;

      if (src) {
        const absoluteUrl = new URL(src, this.targetUrl).toString();
        const category = classifyScriptAsset({ url: absoluteUrl, content: content ?? '', scriptKind, type: 'external' }, this.targetUrl);
        if (shouldSkipScriptAsset({ url: absoluteUrl, content: content ?? '', scriptKind, type: 'external' }, this.targetUrl, this.thirdPartyPolicy)) {
          skippedScriptCount++;
          continue;
        }
        if (!this.prefetchExternalScripts) continue;

        // Collect metadata for batch fetch
        const pageOrigin = new URL(this.targetUrl).origin;
        const scriptOrigin = new URL(absoluteUrl).origin;
        batchScriptMeta.push({
          absoluteUrl,
          id,
          scriptKind,
          category,
          order,
          execution,
          headers: {
            ...DEFAULT_HEADERS,
            ...this.requestHeaders,
            'Referer': this.targetUrl,
            'Sec-Fetch-Dest': 'script',
            'Sec-Fetch-Mode': scriptKind === 'module' ? 'cors' : 'no-cors',
            'Sec-Fetch-Site': scriptOrigin === pageOrigin ? 'same-origin' : 'cross-site',
          },
        });
      } else if (content && content.trim().length > 0) {
        const category = classifyScriptAsset({ url: undefined, content, scriptKind, type: 'inline' }, this.targetUrl);
        if (shouldSkipScriptAsset({ url: undefined, content, scriptKind, type: 'inline' }, this.targetUrl, this.thirdPartyPolicy)) {
          skippedScriptCount++;
          continue;
        }
        scriptAssets.push({ id, type: 'inline', scriptKind, category, content, order, execution });
      }
    }

    // Collect modulepreload URLs for batch fetching
    const modulePreloadUrls: string[] = [];
    if (this.prefetchModulePreloads) {
      $('link[rel="modulepreload"][href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        const absoluteUrl = new URL(href, this.targetUrl).toString();
        if (seenModulePreloads.has(absoluteUrl)) return;
        seenModulePreloads.add(absoluteUrl);
        modulePreloadUrls.push(absoluteUrl);
      });
    }

    // Build combined batch: external scripts + modulepreloads in one RPC call.
    const pageOriginForPreloads = new URL(this.targetUrl).origin;
    const assetsProxyForPreloads = this.proxyUrlForScope('assets');
    const preloadPayloads = modulePreloadUrls.map(url => {
      const preloadOrigin = new URL(url).origin;
      return {
        method: 'GET',
        url,
        headers: {
          ...DEFAULT_HEADERS,
          ...this.requestHeaders,
          'Referer': this.targetUrl,
          'Sec-Fetch-Dest': 'script',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': preloadOrigin === pageOriginForPreloads ? 'same-origin' : 'cross-site',
        },
        headerOrder: DEFAULT_HEADER_ORDER,
        body: '',
        proxy: assetsProxyForPreloads,
      };
    });

    const assetsProxy = this.proxyUrlForScope('assets');
    const scriptPayloads = batchScriptMeta.map(m => ({
      method: 'GET',
      url: m.absoluteUrl,
      headers: m.headers,
      headerOrder: DEFAULT_HEADER_ORDER,
      body: '',
      proxy: assetsProxy,
    }));

    const allPayloads = [...scriptPayloads, ...preloadPayloads];
    if (allPayloads.length > 0) {
      log(`[Harvest] Batch-fetching ${scriptPayloads.length} scripts + ${preloadPayloads.length} modulepreloads...`);
      const allResponses = await phantomBatchFetch(allPayloads);

      // Process script responses
      for (let i = 0; i < batchScriptMeta.length; i++) {
        const meta = batchScriptMeta[i];
        const resp = allResponses[i];
        const logEntry: NetworkLogEntry = {
          type: 'resource_load',
          url: meta.absoluteUrl,
          timestamp: Date.now(),
          initiator: 'Harvester',
          status: resp.status,
          responseHeaders: resp.headers,
          responseBody: resp.status < 400 ? resp.body : null,
        };
        this.logs.push(logEntry);

        if (resp.status < 400) {
          scriptAssets.push({
            id: meta.id,
            type: 'external',
            scriptKind: meta.scriptKind,
            category: meta.category,
            url: meta.absoluteUrl,
            content: resp.body,
            order: meta.order,
            execution: meta.execution,
          });
        } else {
          warn(`[Harvest] Failed to fetch script ${meta.absoluteUrl}: status ${resp.status}`);
        }
      }

      // Process modulepreload responses
      for (let i = 0; i < modulePreloadUrls.length; i++) {
        const url = modulePreloadUrls[i];
        const resp = allResponses[batchScriptMeta.length + i];
        const logEntry: NetworkLogEntry = {
          type: 'resource_load',
          url,
          timestamp: Date.now(),
          initiator: 'Harvester.modulepreload',
          status: resp.status,
          responseHeaders: resp.headers,
          responseBody: resp.status < 400 ? resp.body : null,
        };
        this.logs.push(logEntry);

        if (resp.status < 400) {
          modulePreloads.push({ url, content: resp.body });
        }
      }
    }

    // Sort by order to ensure original execution sequence
    scriptAssets.sort((a, b) => a.order - b.order);

    const initialState: Record<string, any> = {};
    const statePatterns = [
      /window\.__INITIAL_STATE__\s*=\s*({.+?});/,
      /window\.__NEXT_DATA__\s*=\s*({.+?});/,
      /window\.__NUXT__\s*=\s*({.+?});/,
      /window\.__APP_DATA__\s*=\s*({.+?});/
    ];

    for (const pattern of statePatterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        try {
           initialState[pattern.toString()] = JSON.parse(match[1]);
        } catch (e) {}
      }
    }

    $('script[type="application/json"]').each((_, el) => {
        const id = $(el).attr('id');
        const content = $(el).html();
        if (id && content) {
            try { initialState[id] = JSON.parse(content); } catch (e) {}
        }
    });

    $('[data-page], [data-props], [data-state]').each((index, el) => {
      const attrs = ['data-page', 'data-props', 'data-state'] as const;
      for (const attr of attrs) {
        const raw = $(el).attr(attr);
        if (!raw) continue;
        try {
          initialState[`attr:${attr}:${index}`] = JSON.parse(raw);
        } catch {}
      }
    });

    // Pre-warm the entire module dependency graph during harvest.
    // Seeds from external scripts + modulepreloads, then recursively fetches
    // all transitive imports in batches. This eliminates the serial waterfall
    // during esbuild bundling in the execute phase.
    const moduleGraphCache = new Map<string, string>();
    // Seed cache with everything we already fetched
    for (const s of scriptAssets) {
      if (s.url) moduleGraphCache.set(s.url, s.content);
    }
    for (const mp of modulePreloads) {
      moduleGraphCache.set(mp.url, mp.content);
    }

    const moduleEntryUrls = scriptAssets
      .filter(s => s.scriptKind === 'module' && s.url)
      .map(s => s.url!);

    if (moduleEntryUrls.length > 0 || modulePreloads.length > 0) {
      const rootUrls = [...moduleEntryUrls, ...modulePreloads.map(mp => mp.url)];
      await prefetchModuleGraph(rootUrls, moduleGraphCache, finalUrl, {
        proxyUrl: this.proxyUrlForScope('assets'),
      });
    }

    return {
      url: finalUrl,
      status: response.status,
      html,
      scripts: scriptAssets,
      modulePreloads,
      skippedScriptCount,
      initialState,
      cookies: this.cookies,
      headers: response.headers,
      logs: this.logs,
      moduleGraphCache,
    };
  }
}
