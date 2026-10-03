import type {
  Paginated,
  ProductDetailView,
  ProductListItemView,
  ProductQuery,
  TryOnPieceInput,
  TryOnStatusView,
} from '@zed/contracts';
import { apiRequest, ApiError } from '../api-client';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';

export const productsApi = {
  list: (query: Partial<ProductQuery> = {}) =>
    apiRequest<Paginated<ProductListItemView>>('/products', {
      anonymous: true,
      query: query as Record<string, string | number | boolean | undefined>,
    }),

  get: (slug: string) =>
    apiRequest<ProductDetailView>(`/products/${slug}`, { anonymous: true }),

  startTryOn: async (pieces: TryOnPieceInput[], photo: Blob): Promise<TryOnStatusView> => {
    const formData = new FormData();
    formData.append('photo', photo, 'photo.jpg');
    formData.append('pieces', JSON.stringify(pieces));

    const response = await fetch(`${API_URL}/try-on`, {
      method: 'POST',
      body: formData,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ message: response.statusText }));
      throw new ApiError(body?.message ?? `Request failed (${response.status})`, response.status, body);
    }
    return response.json();
  },

  tryOnStatus: (id: string) =>
    apiRequest<TryOnStatusView>(`/try-on/${id}`, { anonymous: true }),

  tryOnImage: async (id: string): Promise<Blob> => {
    const response = await fetch(`${API_URL}/try-on/${id}/image`);
    if (!response.ok) throw new ApiError('The try-on image has expired', response.status, null);
    return response.blob();
  },
};
