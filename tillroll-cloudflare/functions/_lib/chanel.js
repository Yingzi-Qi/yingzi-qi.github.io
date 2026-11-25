// Chanel official-site query policy (Orchestrator 25 Nov 2026; keep consistent
// with PR #3: chanel.com first, chanel.cn / chanel.com/gb only as fallback).
import { CHANEL_FALLBACK_NOTE, isChanelBrand, isChanelFallbackUrl, hostOf, hostMatches } from './brands.js';

export { CHANEL_FALLBACK_NOTE };

export const CHANEL_FALLBACK_SCOPE = ' (site:chanel.cn OR site:chanel.com/gb)';

export function sourceBlockedOrFailed(source) {
  if (!source || source.skipped || source.paused) return false;
  if (source.status === 403 || source.status === 451 || source.status === 502 || source.status === 503) return true;
  if (source.error && /blocked|403|451|network error|failed \((403|451|502|503)\)/i.test(source.error)) return true;
  return false;
}

function urlsFromSources(brave, gemini) {
  const urls = [];
  for (const r of brave?.results || []) if (r.url) urls.push(r.url);
  for (const c of gemini?.parsed?.candidates || []) for (const u of c.sourceUrls || []) urls.push(u);
  for (const ch of gemini?.chunks || []) if (ch.url) urls.push(ch.url);
  return urls;
}

export function hasChanelComHit(brave, gemini) {
  return urlsFromSources(brave, gemini).some(url => hostMatches(hostOf(url), 'chanel.com'));
}

export function shouldRetryChanelFallback(req, brave, gemini) {
  if (!isChanelBrand(req.brand)) return false;
  if (hasChanelComHit(brave, gemini)) return false;
  return sourceBlockedOrFailed(brave) || sourceBlockedOrFailed(gemini);
}

// A non-GBP price from a Chanel fallback mirror (typically chanel.cn) must not
// be used for price matching or the price-fallback ranking.
export function stripNonGbpMirrorPrice(candidate, { chanelFallbackUsed } = {}) {
  if (!chanelFallbackUsed || !candidate) return candidate;
  const urls = candidate.sourceUrls || [];
  const fromFallback = urls.some(isChanelFallbackUrl);
  const fromPrimaryCom = urls.some(url => hostMatches(hostOf(url), 'chanel.com') && !isChanelFallbackUrl(url));
  if (!fromFallback || fromPrimaryCom) return candidate;
  const currency = candidate.currency ? String(candidate.currency).toUpperCase() : null;
  if (candidate.price === null || candidate.price === undefined) return candidate;
  if (currency === 'GBP') return candidate;
  return {
    ...candidate,
    publishedPrice: candidate.price,
    publishedCurrency: currency,
    price: null,
    currency: null,
    nonGbpMirrorPrice: true,
  };
}

export function chanelSourceNote(candidate, { chanelFallbackUsed } = {}) {
  if (!chanelFallbackUsed || !candidate) return null;
  const urls = candidate.sourceUrls || [];
  const fromFallback = urls.some(isChanelFallbackUrl) || urls.some(url => hostMatches(hostOf(url), 'chanel.cn'));
  const fromPrimaryCom = urls.some(url => hostMatches(hostOf(url), 'chanel.com') && !isChanelFallbackUrl(url));
  if (fromFallback && !fromPrimaryCom) return CHANEL_FALLBACK_NOTE;
  return null;
}
