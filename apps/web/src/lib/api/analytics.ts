import type { ProductEventKind, ProductStatsView } from '@zed/contracts';
import { apiRequest } from '../api-client';
import { hasCookieConsent } from '../view-tracking';

const ANON_ID_KEY = 'zed-anon-id';

function anonId(): string | null {
  if (typeof window === 'undefined' || !hasCookieConsent()) return null;

  let id = window.localStorage.getItem(ANON_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem(ANON_ID_KEY, id);
  }
  return id;
}

export const analyticsApi = {
  trackProductEvent(productId: string, kind: ProductEventKind): void {
    const id = anonId();
    if (!id) return;

    void apiRequest<void>('/analytics/product-event', {
      method: 'POST',
      body: { productId, kind, anonId: id },
      anonymous: true,
    }).catch(() => {});
  },

  productStats: (days = 30, limit = 50) =>
    apiRequest<ProductStatsView>('/admin/stats/products', { query: { days, limit } }),
};
