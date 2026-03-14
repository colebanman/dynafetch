import { runPhantom, type RunPhantomInput, type RunPhantomOutput } from './run';
import { compileMatcher } from './matcher';
import { assertSafeHttpUrlSync } from './url-safety.ts';

export class PhantomInputError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'PhantomInputError';
    this.status = status;
  }
}

export function normalizePhantomInput(input: Partial<RunPhantomInput>): RunPhantomInput {
  if (!input.url) {
    throw new PhantomInputError('URL is required');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = assertSafeHttpUrlSync(input.url);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Invalid URL';
    throw new PhantomInputError(message);
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
