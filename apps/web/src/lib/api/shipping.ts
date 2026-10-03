import type { CourierOfficeView, ShippingOptionView, ShippingQuoteInput } from '@zed/contracts';
import { apiRequest } from '../api-client';

export interface TrackingResponse {
  found: boolean;
  trackingNumber: string;
  status?: string;
  deliveredAt?: string | null;
  estimatedDeliveryDate?: string | null;
  events?: { status: string; description: string; location: string | null; occurredAt: string }[];
}

export const shippingApi = {
  quote: (input: ShippingQuoteInput) =>
    apiRequest<ShippingOptionView[]>('/shipping/quote', { method: 'POST', body: input }),

  offices: (provider: 'ECONT' | 'SPEEDY', city?: string) =>
    apiRequest<CourierOfficeView[]>('/shipping/offices', {
      anonymous: true,
      query: { provider, city },
    }),

  track: (trackingNumber: string) =>
    apiRequest<TrackingResponse>(`/shipping/track/${encodeURIComponent(trackingNumber)}`, {
      anonymous: true,
    }),
};
