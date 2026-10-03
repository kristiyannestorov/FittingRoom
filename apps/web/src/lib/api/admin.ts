import type {
  AdjustInventoryInput,
  AdminProductDetailView,
  AdminProductListItemView,
  BatchProductItemInput,
  BatchProductResult,
  BatchProductStatus,
  CreateProductInput,
  GarmentClassification,
  GarmentGenerationProviderKey,
  GenerationStatus,
  OrderStatus,
  OrderView,
  Paginated,
  ProductionTicketStatus,
  ProductType,
  UpdateProductInput,
} from '@zed/contracts';
import { apiRequest, ApiError } from '../api-client';
import { useAuthStore } from '@/store/auth-store';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';

export interface Garment3DJobStatus {
  id: string;
  generationStatus: GenerationStatus;
  failureReason: string | null;
  confidenceScore: number | null;
}

export interface ProductionTicketView {
  id: string;
  status: ProductionTicketStatus;
  notes: string | null;
  createdAt: string;
  orderItem: {
    productName: string;
    variantName: string | null;
    size: string;
    order: { id: string; orderNumber: string };
  };
}

export interface LowStockRow {
  id: string;
  sku: string;
  quantityAvailable: number;
  reorderThreshold: number;
}

export type EmailStatus = 'sent' | 'failed' | 'pending';

export interface OutboundEmailView {
  id: string;
  toEmail: string;
  template: string;
  subject: string;
  payload: unknown;
  sentAt: string | null;
  failedAt: string | null;
  error: string | null;
  attempts: number;
  createdAt: string;
}

export interface AdminStats {
  revenue: {
    last30DaysMinor: number;
    allTimeMinor: number;
    currency: 'EUR';
  };
  orders: {
    total: number;
    last30Days: number;
    byStatus: Record<string, number>;
  };
  inventory: {
    lowStockCount: number;
  };
  production: {
    byStatus: Record<string, number>;
  };
  recentOrders: Array<{
    id: string;
    orderNumber: string;
    status: string;
    totalMinor: number;
    currency: string;
    createdAt: string;
  }>;
}

export const adminApi = {
  stats: {
    get: () => apiRequest<AdminStats>('/admin/stats'),
  },

  orders: {
    list: (status?: OrderStatus, page = 1) =>
      apiRequest<Paginated<OrderView>>('/admin/orders', { query: { status, page } }),
    get: (orderId: string) => apiRequest<OrderView>(`/admin/orders/${orderId}`),
    setStatus: (orderId: string, status: OrderStatus, note?: string) =>
      apiRequest<OrderView>(`/admin/orders/${orderId}/status`, {
        method: 'PATCH',
        body: { status, note },
      }),
  },

  inventory: {
    lowStock: () => apiRequest<LowStockRow[]>('/admin/inventory/low-stock'),
    adjust: (input: AdjustInventoryInput) =>
      apiRequest<{ sku: string; quantityAvailable: number }>('/admin/inventory/adjust', {
        method: 'POST',
        body: input,
      }),
  },

  production: {
    list: (status?: ProductionTicketStatus) =>
      apiRequest<ProductionTicketView[]>('/admin/production-tickets', { query: { status } }),
    setStatus: (ticketId: string, status: ProductionTicketStatus) =>
      apiRequest<{ ok: true }>(`/admin/production-tickets/${ticketId}`, {
        method: 'PATCH',
        body: { status },
      }),
  },

  products: {
    list: (params: { search?: string; page?: number; perPage?: number } = {}) =>
      apiRequest<Paginated<AdminProductListItemView>>('/admin/products', { query: params }),
    create: (input: CreateProductInput) =>
      apiRequest<{ id: string; slug: string }>('/admin/products', { method: 'POST', body: input }),
    get: (productId: string) =>
      apiRequest<AdminProductDetailView>(`/admin/products/${productId}`),
    update: (productId: string, input: UpdateProductInput) =>
      apiRequest<AdminProductDetailView>(`/admin/products/${productId}`, {
        method: 'PATCH',
        body: input,
      }),
    remove: (productId: string) =>
      apiRequest<{ id: string }>(`/admin/products/${productId}`, { method: 'DELETE' }),
    addImages: async (productId: string, files: File[]): Promise<AdminProductDetailView> => {
      const formData = new FormData();
      for (const file of files) formData.append('files', file);
      const accessToken = useAuthStore.getState().tokens?.accessToken;

      const response = await fetch(`${API_URL}/admin/products/${productId}/images`, {
        method: 'POST',
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
        body: formData,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ message: response.statusText }));
        throw new ApiError(body?.message ?? `Request failed (${response.status})`, response.status, body);
      }
      return response.json();
    },
    removeImage: (productId: string, key: string) =>
      apiRequest<AdminProductDetailView>(`/admin/products/${productId}/images`, {
        method: 'DELETE',
        query: { key },
      }),
    publish: (productId: string, published: boolean) =>
      apiRequest<{ id: string; isPublished: boolean }>(`/admin/products/${productId}/publish`, {
        method: 'PATCH',
        query: { published },
      }),
    publishVariant: (variantId: string, published: boolean) =>
      apiRequest<{ id: string; isPublished: boolean }>(`/admin/products/variants/${variantId}/publish`, {
        method: 'PATCH',
        query: { published },
      }),
    createVariant: (
      productId: string,
      input: { name: string; colorName: string; colorHex: string; patternName?: string; priceDeltaMinor?: number },
    ) =>
      apiRequest<{ id: string }>(`/admin/products/${productId}/variants`, {
        method: 'POST',
        body: input,
      }),
    batchCreate: async (
      rows: { item: BatchProductItemInput; front: File; back: File | null }[],
      runAt: string | null,
    ): Promise<{ runAt: string; results: BatchProductResult[] }> => {
      const formData = new FormData();
      formData.append('items', JSON.stringify(rows.map((r) => r.item)));
      if (runAt) formData.append('runAt', runAt);
      rows.forEach((r, i) => {
        formData.append(`front-${i}`, r.front);
        if (r.back) formData.append(`back-${i}`, r.back);
      });
      const accessToken = useAuthStore.getState().tokens?.accessToken;

      const response = await fetch(`${API_URL}/admin/products/batch`, {
        method: 'POST',
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
        body: formData,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ message: response.statusText }));
        throw new ApiError(body?.message ?? `Request failed (${response.status})`, response.status, body);
      }
      return response.json();
    },
    batchStatus: (productIds: string[]) =>
      apiRequest<BatchProductStatus[]>('/admin/products/batch/status', { query: { ids: productIds.join(',') } }),
  },

  emails: {
    list: (status?: EmailStatus, template?: string, page = 1) =>
      apiRequest<Paginated<OutboundEmailView>>('/admin/emails', { query: { status, template, page } }),
    get: (id: string) => apiRequest<OutboundEmailView>(`/admin/emails/${id}`),
  },

  garmentGeneration: {
    generate: async (
      productId: string,
      files: File[],
      provider: GarmentGenerationProviderKey,
    ): Promise<{ garmentId: string; jobId: string }> => {
      const formData = new FormData();
      formData.append('provider', provider.toLowerCase());
      for (const file of files) formData.append('files', file);
      const accessToken = useAuthStore.getState().tokens?.accessToken;

      const response = await fetch(`${API_URL}/admin/products/${productId}/generate-3d`, {
        method: 'POST',
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
        body: formData,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ message: response.statusText }));
        throw new ApiError(body?.message ?? `Request failed (${response.status})`, response.status, body);
      }
      return response.json();
    },

    status: (garmentId: string) =>
      apiRequest<Garment3DJobStatus>(`/admin/garment-generation/jobs/${garmentId}`),

    classifyProduct: (productId: string, productType?: ProductType) =>
      apiRequest<GarmentClassification>(`/admin/products/${productId}/classify`, {
        method: 'POST',
        body: productType ? { productType } : {},
      }),

    classify: async (photos: File[], productType?: ProductType): Promise<GarmentClassification> => {
      const formData = new FormData();
      if (productType) formData.append('productType', productType);
      for (const photo of photos) formData.append('files', photo);
      const accessToken = useAuthStore.getState().tokens?.accessToken;

      const response = await fetch(`${API_URL}/admin/garment-generation/classify`, {
        method: 'POST',
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
        body: formData,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ message: response.statusText }));
        throw new ApiError(body?.message ?? `Request failed (${response.status})`, response.status, body);
      }
      return response.json();
    },
  },
};
