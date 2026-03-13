import * as net from 'node:net';
import { runPhantom, type RunPhantomInput, type RunPhantomOutput } from './run';
import { compileMatcher } from './matcher';

export class PhantomInputError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'PhantomInputError';
    this.status = status;
  }
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0') return true;
  if (h === 'metadata.google.internal') return true;

  const ipVer = net.isIP(h);
  if (!ipVer) return false;

  if (ipVer === 4) {
    const [a, b] = h.split('.').map((x) => Number(x));
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }

  if (h === '::1') return true;
  if (h.startsWith('fe80:')) return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

export function normalizePhantomInput(input: Partial<RunPhantomInput>): RunPhantomInput {
  if (!input.url) {
    throw new PhantomInputError('URL is required');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(input.url);
  } catch {
    throw new PhantomInputError('Invalid URL');
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new PhantomInputError('Only http(s) URLs are allowed');
  }
  if (isPrivateOrLocalHost(parsedUrl.hostname)) {
    throw new PhantomInputError('Refusing to fetch local/private addresses');
  }

  if (input.matcherRegex !== undefined && typeof input.matcherRegex !== 'boolean') {
    throw new PhantomInputError('matcherRegex must be a boolean.');
  }

  if (input.matcherRegex === true) {
    if (typeof input.matcher !== 'string' || input.matcher.trim().length === 0) {
      throw new PhantomInputError('Regex mode requires a non-empty matcher.');
    }
    try {
      compileMatcher({
        matcher: input.matcher,
        matcherRegex: true,
        fuzzyMatch: input.fuzzyMatch !== false,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PhantomInputError(`Invalid regex matcher: ${message}`);
    }
  }

  return {
    ...input,
    url: parsedUrl.toString(),
  };
}

export async function runValidatedPhantom(input: Partial<RunPhantomInput>): Promise<RunPhantomOutput> {
  const normalized = normalizePhantomInput(input);
  return runPhantom(normalized);
}
