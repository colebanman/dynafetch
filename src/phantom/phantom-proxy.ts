import { dynafetchNetFetch, dynafetchNetBatchFetch } from "../../packages/dynafetch-core/src/net/worker-client.ts";
import { assertSafeRemoteUrl } from "./url-safety.ts";

export interface ProxyRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  headerOrder?: string[];
  body: string;
  proxy?: string;
}

export interface ProxyResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
  finalUrl?: string;
  error?: string;
  transport?: "direct" | "dynafetch-net";
  warning?: string;
}

export interface PhantomFetchOptions {
  timeoutMs?: number;
}

export function getGoProxyUrl(): string {
  if (process.env.PHANTOM_DISABLE_PROXY === '1') return '';
  return process.env.DYNAFETCH_NET_BIN || 'stdio://dynafetch-net';
}

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  // Undici supports multi Set-Cookie via getSetCookie().
  const anyH = h as any;
  if (typeof anyH.getSetCookie === 'function') {
    const sc = anyH.getSetCookie();
    if (Array.isArray(sc) && sc.length) out['set-cookie'] = sc.join('\n');
  }
  return out;
}

/**
 * Fetches either via the Go proxy (when configured) or directly from the target URL.
 * We keep redirect handling "manual" so the caller can follow redirects consistently.
 */
const DIRECT_FALLBACK_WARNING =
  "dynafetch-net was unavailable for one or more requests; fell back to Node fetch without TLS/browser impersonation";

const DIRECT_PROXY_ERROR =
  "Direct fallback cannot honor proxy configuration; dynafetch-net is required when proxy is set";

function createTimeoutController(timeoutMs?: number): {
  signal?: AbortSignal;
  dispose: () => void;
  didTimeout: () => boolean;
} {
  if (!timeoutMs || !Number.isFinite(timeoutMs)) {
    return {
      dispose: () => {},
      didTimeout: () => false,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, Math.ceil(timeoutMs)));
  timer.unref?.();

  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
    didTimeout: () => timedOut,
  };
}

async function directFetch(payload: ProxyRequest, options: PhantomFetchOptions = {}): Promise<ProxyResponse> {
  if (payload.proxy) {
    throw new Error(DIRECT_PROXY_ERROR);
  }

  const init: RequestInit = {
    method: payload.method,
    headers: payload.headers,
    redirect: 'manual',
  };
  if (payload.body) init.body = payload.body;
  const timeout = createTimeoutController(options.timeoutMs);
  if (timeout.signal) init.signal = timeout.signal;

  try {
    const resp = await fetch(payload.url, init);
    const body = await resp.text().catch(() => '');
    return {
      status: resp.status,
      body,
      headers: headersToRecord(resp.headers),
      transport: "direct",
      warning: DIRECT_FALLBACK_WARNING,
    };
  } catch (error: unknown) {
    if (timeout.didTimeout()) {
      throw new Error(`dynafetch request timed out after ${Math.max(1, Math.ceil(options.timeoutMs ?? 0))}ms`);
    }
    throw error;
  } finally {
    timeout.dispose();
  }
}

async function dynafetchWorkerFetch(payload: ProxyRequest, options: PhantomFetchOptions = {}): Promise<ProxyResponse> {
  const response = await dynafetchNetFetch(payload, {
    followRedirect: false,
    rpcTimeoutMs: options.timeoutMs,
  });

  return {
    status: response.status,
    body: response.body,
    headers: response.headers,
    finalUrl: response.finalUrl,
    error: response.error,
    transport: "dynafetch-net",
  };
}

export async function phantomFetch(payload: ProxyRequest, options: PhantomFetchOptions = {}): Promise<ProxyResponse> {
  await assertSafeRemoteUrl(payload.url);

  if (process.env.PHANTOM_DISABLE_PROXY === '1' || process.env.DYNAFETCH_DISABLE_NET === '1') {
    return directFetch(payload, options);
  }

  try {
    return await dynafetchWorkerFetch(payload, options);
  } catch (error) {
    if (process.env.DYNAFETCH_DISABLE_DIRECT_FALLBACK === '1') {
      throw error;
    }
    return await directFetch(payload, options);
  }
}

/**
 * Batch-fetch multiple requests in a single Go RPC call.
 * Falls back to parallel individual fetches if the proxy is disabled.
 */
export async function phantomBatchFetch(payloads: ProxyRequest[], options: PhantomFetchOptions = {}): Promise<ProxyResponse[]> {
  if (payloads.length === 0) return [];
  await Promise.all(payloads.map((payload) => assertSafeRemoteUrl(payload.url)));

  if (process.env.PHANTOM_DISABLE_PROXY === '1' || process.env.DYNAFETCH_DISABLE_NET === '1') {
    return Promise.all(payloads.map((payload) => directFetch(payload, options)));
  }

  try {
    const responses = await dynafetchNetBatchFetch(
      payloads,
      {
        followRedirect: false,
        rpcTimeoutMs: options.timeoutMs,
      },
    );
    return responses.map(r => ({
      status: r.status,
      body: r.body,
      headers: r.headers,
      finalUrl: r.finalUrl,
      error: r.error,
      transport: "dynafetch-net",
    }));
  } catch (error) {
    if (process.env.DYNAFETCH_DISABLE_DIRECT_FALLBACK === '1') {
      throw error;
    }
    return Promise.all(payloads.map((payload) => directFetch(payload, options)));
  }
}
