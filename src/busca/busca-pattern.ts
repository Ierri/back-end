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
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

export function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildDiacriticPattern(literal: string): string {
  let out = '';
  for (const char of literal) {
    const base = stripAccents(char).toLowerCase();
    const mapped = base.length === 1 ? DIACRITIC_CLASSES[base] : undefined;
    out += mapped ?? escapeRegexLiteral(char);
  }
  return out;
}

export function normalizeSearchInput(raw: string): NormalizedSearchInput {
  const collapsed = raw.trim().replace(/\s+/g, ' ');
  const cleanText = collapsed.replace(/^@+/, '').trim();
  const canonical = stripAccents(cleanText).toLowerCase();
  const queryHash = createHash('sha256')
    .update(canonical)
    .digest('hex')
    .slice(0, 32);

  const seenTokens = new Set<string>();
  const tokens: string[] = [];
  for (const part of cleanText.split(' ')) {
    const cleaned = part.replace(/^@+/, '').trim();
    if (!cleaned) continue;
    const key = stripAccents(cleaned).toLowerCase();
    if (seenTokens.has(key)) continue;
    seenTokens.add(key);
    tokens.push(cleaned);
    if (tokens.length >= MAX_SEARCH_TOKENS) break;
  }

  const effectiveTokens = tokens.length ? tokens : [cleanText];
  const singleRaw = cleanText.includes(' ') ? null : cleanText.toLowerCase();
  const handleCandidate =
    singleRaw && /^[a-z0-9_]{1,128}$/.test(singleRaw) ? singleRaw : null;

  const phraseSource = buildDiacriticPattern(cleanText);
  return {
    cleanText,
    canonical,
    queryHash,
    handleCandidate,
    phraseSource,
    prefixSource: `^${phraseSource}`,
    tokenSources: effectiveTokens.map((token) => buildDiacriticPattern(token)),
  };
}
