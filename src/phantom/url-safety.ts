import { lookup } from "node:dns/promises";
import * as net from "node:net";

const BLOCKED_HOSTNAMES = new Set([
  "0.0.0.0",
  "localhost",
  "metadata.google.internal",
]);

const hostnameLookupCache = new Map<string, Promise<boolean>>();

export function normalizeHostname(hostname: string): string {
  return hostname.trim().replace(/^\[|\]$/g, "").replace(/\.+$/g, "").toLowerCase();
}

export function isPrivateOrLocalHost(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (!h) return false;
  if (BLOCKED_HOSTNAMES.has(h) || h.endsWith(".localhost")) return true;

  const ipVer = net.isIP(h);
  if (!ipVer) return false;

  if (ipVer === 4) {
    const [a, b] = h.split(".").map((value) => Number(value));
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }

  if (h === "::1") return true;
  if (h.startsWith("fe80:")) return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true;
  return false;
}

export function assertSafeHttpUrlSync(input: string): URL {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(input);
  } catch {
    throw new Error("Invalid URL");
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed");
  }
  if (isPrivateOrLocalHost(parsedUrl.hostname)) {
    throw new Error("Refusing to fetch local/private addresses");
  }

  return parsedUrl;
}

async function hostnameResolvesToPrivateAddress(hostname: string): Promise<boolean> {
  const normalized = normalizeHostname(hostname);
  if (!normalized || net.isIP(normalized)) return false;

  let pending = hostnameLookupCache.get(normalized);
  if (!pending) {
    pending = lookup(normalized, { all: true, verbatim: true })
      .then((records) => records.some((record) => isPrivateOrLocalHost(record.address)))
      .catch(() => false);
    hostnameLookupCache.set(normalized, pending);
  }

  return pending;
}

export async function assertSafeRemoteUrl(input: string): Promise<URL> {
  const parsedUrl = assertSafeHttpUrlSync(input);
  if (await hostnameResolvesToPrivateAddress(parsedUrl.hostname)) {
    throw new Error("Refusing to fetch local/private addresses");
  }
  return parsedUrl;
}
