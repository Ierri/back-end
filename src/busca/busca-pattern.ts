import { createHash } from 'node:crypto';

export const MAX_SEARCH_TOKENS = 5;

const DIACRITIC_CLASSES: Record<string, string> = {
  a: '[aáàâãä]',
  e: '[eéèêë]',
  i: '[iíìîï]',
  o: '[oóòôõö]',
  u: '[uúùûü]',
  c: '[cç]',
  n: '[nñ]',
};

export type NormalizedSearchInput = {
  cleanText: string;
  canonical: string;
  queryHash: string;
  handleCandidate: string | null;
  phraseSource: string;
  prefixSource: string;
  tokenSources: string[];
};

export function stripAccents(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '');
}

export function stripOrphanCombiningMarks(value: string): string {
  return value.normalize('NFC').replace(/\p{M}/gu, '');
}

export function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildDiacriticPattern(literal: string): string {
  let out = '';
  for (const char of stripOrphanCombiningMarks(literal)) {
    const base = stripAccents(char).toLowerCase();
    const mapped = base.length === 1 ? DIACRITIC_CLASSES[base] : undefined;
    out += mapped ?? escapeRegexLiteral(char);
  }
  return out;
}

export function normalizeSearchInput(raw: string): NormalizedSearchInput {
  const sanitized = stripOrphanCombiningMarks(raw).trim().replace(/\s+/g, ' ');
  const rawParts = sanitized.split(' ');

  const seenTokens = new Set<string>();
  const tokens: string[] = [];
  for (const part of rawParts) {
    const cleaned = part.replace(/^@+/, '').trim();
    if (!cleaned) continue;
    const key = stripAccents(cleaned).toLowerCase();
    if (!key || seenTokens.has(key)) continue;
    seenTokens.add(key);
    tokens.push(cleaned);
    if (tokens.length >= MAX_SEARCH_TOKENS) break;
  }

  const fallback = sanitized.replace(/@/g, '').trim();
  const effectiveTokens = tokens.length ? tokens : fallback ? [fallback] : [];
  const cleanText = effectiveTokens.join(' ');
  const canonical = stripAccents(cleanText).toLowerCase();

  const singleCanonical =
    effectiveTokens.length === 1
      ? stripAccents(effectiveTokens[0]).toLowerCase()
      : null;
  const handleCandidate =
    singleCanonical && /^[a-z0-9_]{1,128}$/.test(singleCanonical)
      ? singleCanonical
      : null;

  const phraseSource = buildDiacriticPattern(cleanText);
  const prefixSource = `^${phraseSource}`;
  const tokenSources = effectiveTokens.map((token) =>
    buildDiacriticPattern(token),
  );

  const queryHash = createHash('sha256')
    .update(
      JSON.stringify({
        h: handleCandidate,
        p: prefixSource,
        t: tokenSources,
      }),
    )
    .digest('hex')
    .slice(0, 32);

  return {
    cleanText,
    canonical,
    queryHash,
    handleCandidate,
    phraseSource,
    prefixSource,
    tokenSources,
  };
}
