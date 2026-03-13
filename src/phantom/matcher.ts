export type CompileMatcherInput = {
  matcher: string;
  matcherRegex?: boolean;
  fuzzyMatch?: boolean;
};

export type MatchLocation = {
  index: number;
  length: number;
};

export type CompiledMatcher = {
  kind: 'plain' | 'regex';
  raw: string;
  test: (value: string) => boolean;
  find: (value: string) => MatchLocation | null;
};

const VALID_REGEX_FLAGS = new Set(['d', 'g', 'i', 'm', 's', 'u', 'v', 'y']);

function hasOnlyValidFlags(flags: string): boolean {
  for (const ch of flags) {
    if (!VALID_REGEX_FLAGS.has(ch)) return false;
  }
  return true;
}

function dedupeFlags(flags: string): string {
  const seen = new Set<string>();
  let out = '';
  for (const ch of flags) {
    if (!seen.has(ch)) {
      seen.add(ch);
      out += ch;
    }
  }
  return out;
}

function parseRegexLiteral(input: string): { source: string; flags: string } | null {
  if (!input.startsWith('/')) return null;
  let lastSlash = -1;
  for (let i = input.length - 1; i > 0; i--) {
    if (input[i] !== '/') continue;
    let slashEscapes = 0;
    for (let j = i - 1; j >= 0 && input[j] === '\\'; j--) slashEscapes++;
    if (slashEscapes % 2 === 0) {
      lastSlash = i;
      break;
    }
  }
  if (lastSlash <= 0) return null;
  return {
    source: input.slice(1, lastSlash),
    flags: input.slice(lastSlash + 1),
  };
}

export function compileMatcher(input: CompileMatcherInput): CompiledMatcher {
  const matcher = String(input.matcher ?? '');
  const fuzzyMatch = input.fuzzyMatch !== false;
  const matcherRegex = input.matcherRegex === true;

  if (!matcherRegex) {
    const needle = fuzzyMatch ? matcher.toLowerCase() : matcher;
    return {
      kind: 'plain',
      raw: matcher,
      test: (value: string) => {
        const hay = fuzzyMatch ? value.toLowerCase() : value;
        return hay.includes(needle);
      },
      find: (value: string) => {
        const hay = fuzzyMatch ? value.toLowerCase() : value;
        const idx = hay.indexOf(needle);
        if (idx < 0) return null;
        return { index: idx, length: Math.max(needle.length, 1) };
      },
    };
  }

  const parsed = parseRegexLiteral(matcher);
  const source = parsed ? parsed.source : matcher;
  let flags = parsed ? parsed.flags : '';
  if (!source) {
    throw new Error('Regex matcher cannot be empty.');
  }
  if (!hasOnlyValidFlags(flags)) {
    throw new Error(`Invalid regex flags "${flags}".`);
  }
  flags = dedupeFlags(flags);
  if (fuzzyMatch && !flags.includes('i')) flags += 'i';

  // Stateful flags make repeated test/exec calls brittle; remove them.
  const stableFlags = flags.replace(/[gy]/g, '');
  const regex = new RegExp(source, stableFlags);

  return {
    kind: 'regex',
    raw: matcher,
    test: (value: string) => regex.test(value),
    find: (value: string) => {
      const m = regex.exec(value);
      if (!m || typeof m.index !== 'number') return null;
      const len = typeof m[0] === 'string' ? m[0].length : 0;
      return { index: m.index, length: Math.max(len, 1) };
    },
  };
}

