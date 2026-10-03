import type { OrderView } from '@zed/contracts';
import { apiRequest } from '../api-client';

export const ordersApi = {
  list: () => apiRequest<OrderView[]>('/orders'),
  get: (orderId: string) => apiRequest<OrderView>(`/orders/${orderId}`),
};
