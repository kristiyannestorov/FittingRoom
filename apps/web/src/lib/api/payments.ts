import type { CheckoutInput, CheckoutSessionView } from '@zed/contracts';
import { apiRequest } from '../api-client';

export const paymentsApi = {
  providers: () =>
    apiRequest<{ providers: string[]; default: string }>('/payments/providers', {
      method: 'POST',
      anonymous: true,
    }),

  checkout: (input: CheckoutInput) =>
    apiRequest<CheckoutSessionView>('/payments/checkout', { method: 'POST', body: input }),

  reconcile: (orderNumber: string) =>
    apiRequest<{ status: string }>('/payments/reconcile', {
      method: 'POST',
      query: { order: orderNumber },
    }),
};
