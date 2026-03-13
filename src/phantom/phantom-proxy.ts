import { dynafetchNetFetch, dynafetchNetBatchFetch } from "../../packages/dynafetch-core/src/net/worker-client.ts";

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
async function directFetch(payload: ProxyRequest): Promise<ProxyResponse> {
  const init: RequestInit = {
    method: payload.method,
    headers: payload.headers,
    redirect: 'manual',
  };
  if (payload.body) init.body = payload.body;

  const resp = await fetch(payload.url, init);
  const body = await resp.text().catch(() => '');
  return { status: resp.status, body, headers: headersToRecord(resp.headers) };
}

async function dynafetchWorkerFetch(payload: ProxyRequest): Promise<ProxyResponse> {
  const response = await dynafetchNetFetch(payload, {
    followRedirect: false,
  });

  return {
    status: response.status,
    body: response.body,
    headers: response.headers,
    finalUrl: response.finalUrl,
    error: response.error,
  };
}

export async function phantomFetch(payload: ProxyRequest): Promise<ProxyResponse> {
  if (process.env.PHANTOM_DISABLE_PROXY === '1' || process.env.DYNAFETCH_DISABLE_NET === '1') {
    return directFetch(payload);
  }

  try {
    return await dynafetchWorkerFetch(payload);
  } catch (error) {
    if (process.env.DYNAFETCH_DISABLE_DIRECT_FALLBACK === '1') {
      throw error;
    }
    return await directFetch(payload);
  }
}

/**
 * Batch-fetch multiple requests in a single Go RPC call.
 * Falls back to parallel individual fetches if the proxy is disabled.
 */
export async function phantomBatchFetch(payloads: ProxyRequest[]): Promise<ProxyResponse[]> {
  if (payloads.length === 0) return [];

  if (process.env.PHANTOM_DISABLE_PROXY === '1' || process.env.DYNAFETCH_DISABLE_NET === '1') {
    return Promise.all(payloads.map(p => directFetch(p)));
  }

  try {
    const responses = await dynafetchNetBatchFetch(
      payloads,
      { followRedirect: false },
    );
    return responses.map(r => ({
      status: r.status,
      body: r.body,
      headers: r.headers,
      finalUrl: r.finalUrl,
      error: r.error,
    }));
  } catch (error) {
    if (process.env.DYNAFETCH_DISABLE_DIRECT_FALLBACK === '1') {
      throw error;
    }
    return Promise.all(payloads.map(p => directFetch(p)));
  }
}
