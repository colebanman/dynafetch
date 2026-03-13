import { phantomBatchFetch } from './phantom-proxy.ts';
import { chromeSubresourceHeaders } from './headers.ts';

const STUB_EXTENSIONS = new Set([
  '.css', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg',
  '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4',
  '.webm', '.mov', '.wasm',
]);

function isStubAsset(url: string): boolean {
  try {
    const p = new URL(url).pathname.toLowerCase();
    const ext = p.slice(p.lastIndexOf('.'));
    return STUB_EXTENSIONS.has(ext);
  } catch {
    const p = url.split('?')[0].split('#')[0].toLowerCase();
    const ext = p.slice(p.lastIndexOf('.'));
    return STUB_EXTENSIONS.has(ext);
  }
}

function scanImports(code: string, baseUrl: string, originFallback: string): string[] {
  const deps: string[] = [];
  const importRe = /(?:import|export)\s*.*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(code)) !== null) {
    const specifier = m[1] || m[2];
    if (!specifier) continue;
    let resolved: string;
    try {
      if (specifier.startsWith('http://') || specifier.startsWith('https://')) {
        resolved = specifier;
      } else if (specifier.startsWith('/')) {
        resolved = new URL(specifier, originFallback).toString();
      } else {
        resolved = new URL(specifier, baseUrl).toString();
      }
    } catch { continue; }
    if (!isStubAsset(resolved)) {
      deps.push(resolved);
    }
  }
  return deps;
}

/**
 * Recursively discovers and batch-fetches the entire module dependency graph
 * starting from the given root URLs. Populates the `cache` map with url→source.
 * Returns the number of modules fetched.
 */
export async function prefetchModuleGraph(
  rootUrls: string[],
  cache: Map<string, string>,
  pageUrl: string,
  opts?: { maxRounds?: number; proxyUrl?: string },
): Promise<number> {
  const maxRounds = opts?.maxRounds ?? 8;
  const { headers: subHeaders } = chromeSubresourceHeaders(pageUrl);
  subHeaders["sec-fetch-dest"] = "script";
  subHeaders["sec-fetch-mode"] = "cors";
  subHeaders["sec-fetch-site"] = "same-origin";

  let origin: string;
  try { origin = new URL(pageUrl).origin; } catch { origin = pageUrl; }

  const seen = new Set<string>();
  let toFetch: string[] = [];
  let totalFetched = 0;

  // Seed pass: scan all cached sources to discover uncached deps
  const toScan = [...rootUrls];
  while (toScan.length > 0) {
    const url = toScan.pop()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const code = cache.get(url);
    if (!code) {
      toFetch.push(url);
      continue;
    }
    const deps = scanImports(code, url, origin);
    for (const d of deps) {
      if (!seen.has(d)) toScan.push(d);
    }
  }

  // Iteratively batch-fetch unknowns and scan their imports
  for (let round = 0; round < maxRounds && toFetch.length > 0; round++) {
    if (process.env.PHANTOM_DEBUG_MODULES === '1') {
      console.log(`[prefetch] Round ${round}: ${toFetch.length} modules`);
    }

    const payloads = toFetch.map(u => ({
      method: 'GET',
      url: u,
      headers: { ...subHeaders },
      headerOrder: Object.keys(subHeaders),
      body: '',
      proxy: opts?.proxyUrl,
    }));

    const responses = await phantomBatchFetch(payloads);
    const newToScan: string[] = [];

    for (let i = 0; i < toFetch.length; i++) {
      const u = toFetch[i];
      const r = responses[i];
      if (r.status < 400 && r.body) {
        cache.set(u, r.body);
        totalFetched++;
        newToScan.push(u);
      }
    }

    toFetch = [];
    for (const url of newToScan) {
      const code = cache.get(url);
      if (!code) continue;
      const deps = scanImports(code, url, origin);
      for (const d of deps) {
        if (!seen.has(d)) {
          seen.add(d);
          if (cache.has(d)) {
            newToScan.push(d);
          } else {
            toFetch.push(d);
          }
        }
      }
    }
  }

  return totalFetched;
}
