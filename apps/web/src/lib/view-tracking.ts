import type { ProductType } from '@zed/contracts';

const CONSENT_COOKIE = 'zed-cookie-consent';
const VIEWS_COOKIE = 'zed-category-views';
const CLAIMED_COOKIE = 'zed-claimed-offers';

export const VIEW_THRESHOLD = 3;

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function writeCookie(name: string, value: string, maxAgeSeconds: number) {
  document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${maxAgeSeconds}; path=/; SameSite=Lax`;
}

function readJsonCookie(name: string): Record<string, number> {
  try {
    return JSON.parse(readCookie(name) ?? '{}');
  } catch {
    return {};
  }
}

export function hasCookieConsent(): boolean {
  return readCookie(CONSENT_COOKIE) === 'accepted';
}

export function recordProductView(productType: ProductType): number {
  if (!hasCookieConsent()) return 0;

  const counts = readJsonCookie(VIEWS_COOKIE);
  counts[productType] = (counts[productType] ?? 0) + 1;
  writeCookie(VIEWS_COOKIE, JSON.stringify(counts), 60 * 60 * 24 * 30);
  return counts[productType];
}

export function hasClaimedOffer(productType: ProductType): boolean {
  const claimed = readJsonCookie(CLAIMED_COOKIE);
  return Boolean(claimed[productType]);
}

export function markOfferClaimed(productType: ProductType): void {
  const claimed = readJsonCookie(CLAIMED_COOKIE);
  claimed[productType] = 1;
  writeCookie(CLAIMED_COOKIE, JSON.stringify(claimed), 60 * 60 * 24 * 30);
}
