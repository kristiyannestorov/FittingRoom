import type { AddToCartInput, CartView } from '@zed/contracts';
import { apiRequest } from '../api-client';

export const cartApi = {
  get: () => apiRequest<CartView>('/cart'),
  add: (input: AddToCartInput) => apiRequest<CartView>('/cart/items', { method: 'POST', body: input }),
  updateQuantity: (itemId: string, quantity: number) =>
    apiRequest<CartView>(`/cart/items/${itemId}`, { method: 'PATCH', body: { quantity } }),
  remove: (itemId: string) => apiRequest<CartView>(`/cart/items/${itemId}`, { method: 'DELETE' }),
};
