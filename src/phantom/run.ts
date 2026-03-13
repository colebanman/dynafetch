import { Harvester } from './harvest';
import { Executor } from './execute';
import type { NetworkLogEntry, ExecutionError } from './types';
import { compileMatcher } from './matcher';

export type RunPhantomInput = {
  url: string;
  matcher?: string | null;
  matcherRegex?: boolean;
  findAll?: boolean;
  fuzzyMatch?: boolean;
  /** Minimum ms before checking idle state. @default 75 */
  minWaitMs?: number;
  /** Ms of zero pending activity before settling. @default 100 */
  idleWaitMs?: number;
  /** Hard cap ms on quiescence wait. @default 2000 */
  maxWaitMs?: number;
  /** Max ms to wait for module bundling. @default 6000 */
  moduleWaitMs?: number;
  prefetchExternalScripts?: boolean;
  includeBodies?: boolean;
};

export type NetworkLogEntryOut = Omit<NetworkLogEntry, 'requestBody' | 'responseBody'> & {
  requestBody?: string | null;
  responseBody?: string | null;
  requestBodyBytes?: number;
  responseBodyBytes?: number;
};

export type RunPhantomOutput = {
  url: string;
  matcher: string | null;
  match_count: number;
  matches: Array<{
    type: NetworkLogEntry['type'];
    url: string;
    method?: string;
    status?: number;
    requestHeaders?: Record<string, string>;
    responseHeaders?: Record<string, string>;
    data: unknown;
  }>;
  total_requests: number;
  all_requests: NetworkLogEntryOut[];
  all_requests_bodies_included: boolean;
  execution_errors?: ExecutionError[];
  timings_ms: {
    total: number;
    harvest: number;
    execute: number;
    transform?: number;
    quiescence?: number;
    scripts_transformed?: number;
  };
};

/**
 * Recursively narrows a large object to the most specific subtree containing the match.
 * Prevents returning multi-MB blobs by drilling down to the tightest containing node.
 */
function extractMatchingSubtree(
  obj: unknown,
  matcher: (value: string) => boolean,
  path: string = ''
): { value: unknown; path: string } | null {
  if (obj === null || obj === undefined) return null;

  if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') {
    const str = String(obj);
    if (matcher(str)) return { value: obj, path };
    return null;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const child = extractMatchingSubtree(obj[i], matcher, `${path}[${i}]`);
      if (child) return child;
    }
    return null;
  }

  if (typeof obj === 'object') {
    // First try to find a deeper match in children
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      const child = extractMatchingSubtree(
        (obj as Record<string, unknown>)[key],
        matcher,
        path ? `${path}.${key}` : key
      );
      if (child) return child;
    }
    // If no child matched, check if the whole object serialized contains it
    try {
      const serialized = JSON.stringify(obj);
      if (matcher(serialized)) return { value: obj, path };
    } catch {}
    return null;
  }

  return null;
}

export async function runPhantom(input: RunPhantomInput): Promise<RunPhantomOutput> {
  const startTotal = Date.now();

  const url = input.url;
  const matcher = input.matcher ?? null;
  const matcherRegex = input.matcherRegex === true;
  const findAll = input.findAll === true;
  const fuzzyMatch = input.fuzzyMatch !== false;
  const prefetchExternalScripts = input.prefetchExternalScripts !== false;
  const includeBodies = input.includeBodies === true;

  const compiledMatcher = matcher
    ? compileMatcher({ matcher, matcherRegex, fuzzyMatch })
    : null;

  const startHarvest = Date.now();
  const harvester = new Harvester(url, { prefetchExternalScripts });
  const harvestResult = await harvester.harvest();
  const harvestMs = Date.now() - startHarvest;

  // Early exit: if matcher finds data in initialState, skip execution entirely.
  const earlyMatches: Array<{
    type: NetworkLogEntry['type'];
    url: string;
    method?: string;
    status?: number;
    requestHeaders?: Record<string, string>;
    responseHeaders?: Record<string, string>;
    data: unknown;
  }> = [];

  if (compiledMatcher && !findAll) {
    const stateEntries = Object.entries(harvestResult.initialState ?? {});
    for (const [key, stateValue] of stateEntries) {
      let serialized: string;
      try { serialized = JSON.stringify(stateValue); } catch { continue; }
      if (!compiledMatcher.test(serialized)) continue;

      const subtree = extractMatchingSubtree(stateValue, compiledMatcher.test);
      const matchValue = subtree ? subtree.value : stateValue;
      const matchPath = subtree ? subtree.path : key;
      let data: unknown = matchValue;
      try {
        const s = JSON.stringify(matchValue);
        if (s.length > 8192) data = s.slice(0, 8192) + '...(truncated)';
      } catch {}

      earlyMatches.push({
        type: 'resource_load',
        url,
        method: undefined,
        status: undefined,
        requestHeaders: undefined,
        responseHeaders: undefined,
        data: { source: 'initial_state', key, path: matchPath, value: data },
      });
      break;
    }
  }

  if (earlyMatches.length > 0) {
    const totalMs = Date.now() - startTotal;
    return {
      url: harvestResult.url,
      matcher,
      match_count: earlyMatches.length,
      matches: earlyMatches,
      total_requests: harvestResult.logs.length,
      all_requests: harvestResult.logs.map(r => {
        const requestBodyBytes = typeof r.requestBody === 'string' ? Buffer.byteLength(r.requestBody, 'utf8') : 0;
        const responseBodyBytes = typeof r.responseBody === 'string' ? Buffer.byteLength(r.responseBody, 'utf8') : 0;
        if (includeBodies) return { ...r, requestBodyBytes, responseBodyBytes };
        const { requestBody: _rb, responseBody: _respB, ...rest } = r;
        return { ...rest, requestBodyBytes, responseBodyBytes };
      }),
      all_requests_bodies_included: includeBodies,
      timings_ms: {
        total: totalMs,
        harvest: harvestMs,
        execute: 0,
      },
    };
  }

  const startExecute = Date.now();
  const executor = new Executor(harvestResult, {
    targetValue: matcher,
    matcherRegex,
    findAll,
    fuzzyMatch,
    quiescence: {
      minWaitMs: input.minWaitMs,
      idleWaitMs: input.idleWaitMs,
      maxWaitMs: input.maxWaitMs,
    },
    moduleWaitMs: input.moduleWaitMs,
  });
  const execResult = await executor.execute();
  const executeMs = Date.now() - startExecute;

  const matches = execResult.matchedRequests.map((req) => {
    let parsedBody: unknown = req.responseBody;
    if (typeof req.responseBody === 'string') {
      const trimmed = req.responseBody.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          parsedBody = JSON.parse(req.responseBody);
        } catch {
          // Leave as string
        }
      }
    }

    return {
      type: req.type,
      url: req.url,
      method: req.method,
      status: req.status,
      requestHeaders: req.requestHeaders,
      responseHeaders: req.responseHeaders,
      data: parsedBody,
    };
  });

  // --- initialState scan: search SSR-embedded JSON before falling back to raw HTML ---
  if (compiledMatcher && matches.length === 0) {
    const stateEntries = Object.entries(harvestResult.initialState ?? {});
    for (const [key, stateValue] of stateEntries) {
      // Quick check: does the serialized blob even contain the needle?
      let serialized: string;
      try {
        serialized = JSON.stringify(stateValue);
      } catch {
        continue;
      }
      if (!compiledMatcher.test(serialized)) continue;

      // Drill into the subtree for a tight match
      const subtree = extractMatchingSubtree(stateValue, compiledMatcher.test);
      const matchValue = subtree ? subtree.value : stateValue;
      const matchPath = subtree ? subtree.path : key;

      // Truncate the value if it's too large to avoid multi-MB match entries
      let data: unknown = matchValue;
      try {
        const s = JSON.stringify(matchValue);
        if (s.length > 8192) {
          data = s.slice(0, 8192) + '...(truncated)';
        }
      } catch {}

      matches.push({
        type: 'resource_load',
        url,
        method: undefined,
        status: undefined,
        requestHeaders: undefined,
        responseHeaders: undefined,
        data: {
          source: 'initial_state',
          key,
          path: matchPath,
          value: data,
        },
      });

      if (!findAll) break;
    }
  }

  // --- HTML fallback: search raw document HTML as last resort ---
  if (compiledMatcher && matches.length === 0) {
    const source = harvestResult.html ?? '';
    const htmlMatch = compiledMatcher.find(source);
    if (htmlMatch) {
      const rawStart = Math.max(0, htmlMatch.index - 120);
      const rawEnd = Math.min(source.length, htmlMatch.index + htmlMatch.length + 120);
      const snippet = source.slice(rawStart, rawEnd);
      matches.push({
        // Reuse an existing network-like type to avoid changing response schema.
        type: 'resource_load',
        url,
        method: undefined,
        status: undefined,
        requestHeaders: undefined,
        responseHeaders: undefined,
        data: {
          source: 'document_html',
          snippet,
        },
      });
    }

    if (matches.length === 0) {
      const stripTags = source
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ');
      const normalizedText = compiledMatcher.kind === 'plain'
        ? stripTags.replace(/\s+/g, ' ').trim()
        : stripTags;
      const textMatch = compiledMatcher.find(normalizedText);
      if (textMatch) {
        const s = Math.max(0, textMatch.index - 120);
        const e = Math.min(normalizedText.length, textMatch.index + textMatch.length + 120);
        matches.push({
          type: 'resource_load',
          url,
          method: undefined,
          status: undefined,
          requestHeaders: undefined,
          responseHeaders: undefined,
          data: {
            source: 'document_text',
            snippet: normalizedText.slice(s, e),
          },
        });
      }
    }
  }

  const totalMs = Date.now() - startTotal;

  const allRequests: NetworkLogEntryOut[] = execResult.logs.map((r) => {
    const requestBodyBytes = typeof r.requestBody === 'string' ? Buffer.byteLength(r.requestBody, 'utf8') : 0;
    const responseBodyBytes = typeof r.responseBody === 'string' ? Buffer.byteLength(r.responseBody, 'utf8') : 0;
    if (includeBodies) {
      return { ...r, requestBodyBytes, responseBodyBytes };
    }
    // Drop bodies to avoid multi-MB JSON payloads that inflate client-observed latency.
    const { requestBody: _rb, responseBody: _respB, ...rest } = r;
    return { ...rest, requestBodyBytes, responseBodyBytes };
  });

  return {
    url,
    matcher,
    match_count: matches.length,
    matches,
    total_requests: execResult.logs.length,
    all_requests: allRequests,
    all_requests_bodies_included: includeBodies,
    execution_errors: execResult.errors,
    timings_ms: {
      total: totalMs,
      harvest: harvestMs,
      execute: executeMs,
      transform: execResult.timings?.transform_ms_total,
      quiescence: execResult.timings?.quiescence_ms,
      scripts_transformed: execResult.timings?.scripts_transformed_count,
    },
  };
}
