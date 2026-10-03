import { z } from 'zod';
import {
  CLOTHING_SIZES,
  PRODUCT_CATEGORIES,
  PRODUCT_TYPE_CATEGORIES,
  PRODUCT_TYPES,
  type ProductCategory,
  type ProductType,
} from './sizing';
import {
  DELIVERY_MODES,
  GENDERS,
  PAYMENT_PROVIDERS,
  SHIPPING_PROVIDERS,
  type FulfillmentType,
  type Gender,
  type GenerationStatus,
  type OrderStatus,
  type ShipmentStatus,
  type UserRole,
} from './enums';
import { SUPPORTED_CURRENCIES, type Currency } from './money';
import type { Garment3DView } from './garment';

export const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(10).max(200),
  fullName: z.string().min(1).max(120),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(1) });
export type RefreshInput = z.infer<typeof refreshSchema>;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export interface UserView {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  createdAt: string;
}

export interface AuthResponse {
  user: UserView;
  tokens: AuthTokens;
}

export interface ProductVariantView {
  id: string;
  name: string;
  colorName: string;
  colorHex: string;
  patternName: string | null;
  thumbnailUrl: string | null;
  priceDeltaMinor: number;
}

export interface ProductListItemView {
  id: string;
  slug: string;
  name: string;
  productType: ProductType;
  category: string;
  gender: Gender;
  basePriceMinor: number;
  currency: Currency;
  thumbnailUrl: string | null;
  availableSizes: string[];
  fulfillmentType: FulfillmentType;
  variants: ProductVariantView[];
}

export interface ProductDetailView extends ProductListItemView {
  description: string;
  careInstructions: string | null;
  materials: string[];
  inStockSizes: string[];
  imageUrls: string[];
  garment3D: Garment3DView | null;
  avatarModelUrls: Record<Gender, string> | null;
  tryOnAvailable: boolean;
}

export const MAX_TRY_ON_PIECES = 2;

export const tryOnPiecesSchema = z
  .array(
    z.object({
      slug: z.string().min(1).max(200),
      variantId: z.string().uuid().optional(),
    }),
  )
  .min(1)
  .max(MAX_TRY_ON_PIECES);
export type TryOnPieceInput = z.infer<typeof tryOnPiecesSchema>[number];

export type TryOnStatus = 'queued' | 'processing' | 'done' | 'failed';

export interface TryOnStatusView {
  id: string;
  status: TryOnStatus;
  error: string | null;
  position: number | null;
  pieces: number;
}

export const productQuerySchema = z.object({
  productType: z.enum(PRODUCT_TYPES).optional(),
  gender: z.enum(GENDERS).optional(),
  category: z.enum(PRODUCT_CATEGORIES).optional(),
  size: z.enum(CLOTHING_SIZES).optional(),
  minPriceMinor: z.coerce.number().int().nonnegative().optional(),
  maxPriceMinor: z.coerce.number().int().nonnegative().optional(),
  search: z.string().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(60).default(24),
});
export type ProductQuery = z.infer<typeof productQuerySchema>;

export interface Paginated<T> {
  items: T[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export const addToCartSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().nullable().optional(),
  size: z.enum(CLOTHING_SIZES),
  quantity: z.number().int().min(1).max(10).default(1),
});
export type AddToCartInput = z.infer<typeof addToCartSchema>;

export const updateCartItemSchema = z.object({
  quantity: z.number().int().min(0).max(10),
});
export type UpdateCartItemInput = z.infer<typeof updateCartItemSchema>;

export interface CartItemView {
  id: string;
  productId: string;
  productName: string;
  productSlug: string;
  variantId: string | null;
  variantName: string | null;
  size: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  thumbnailUrl: string | null;
  available: boolean;
}

export interface CartView {
  id: string;
  items: CartItemView[];
  subtotalMinor: number;
  currency: Currency;
  itemCount: number;
}

export const addressSchema = z.object({
  fullName: z.string().min(1).max(120),
  phone: z.string().min(6).max(32),
  email: z.string().email().max(255),
  countryCode: z.string().length(2).default('BG'),
  city: z.string().min(1).max(80),
  postCode: z.string().min(2).max(12),
  street: z.string().max(120).optional(),
  streetNumber: z.string().max(20).optional(),
  floor: z.string().max(20).optional(),
  apartment: z.string().max(20).optional(),
  note: z.string().max(300).optional(),
  officeId: z.string().max(60).optional(),
});
export type AddressInput = z.infer<typeof addressSchema>;

export const shippingQuoteSchema = z.object({
  deliveryMode: z.enum(DELIVERY_MODES),
  address: addressSchema,
  provider: z.enum(SHIPPING_PROVIDERS).optional(),
});
export type ShippingQuoteInput = z.infer<typeof shippingQuoteSchema>;

export interface ShippingOptionView {
  provider: string;
  serviceCode: string;
  serviceName: string;
  priceMinor: number;
  currency: Currency;
  estimatedDeliveryDays: number | null;
  deliveryMode: string;
}

export interface CourierOfficeView {
  id: string;
  provider: string;
  name: string;
  city: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
}

export const checkoutSchema = z.object({
  paymentProvider: z.enum(PAYMENT_PROVIDERS),
  shippingProvider: z.enum(SHIPPING_PROVIDERS),
  deliveryMode: z.enum(DELIVERY_MODES),
  serviceCode: z.string().min(1).max(60),
  address: addressSchema,
  currency: z.enum(SUPPORTED_CURRENCIES).default('EUR'),
  idempotencyKey: z.string().uuid(),
  discountCode: z.string().min(1).max(40).optional(),
});
export type CheckoutInput = z.infer<typeof checkoutSchema>;

export interface CheckoutSessionView {
  orderId: string;
  orderNumber: string;
  provider: string;
  redirectUrl: string | null;
  clientSecret: string | null;
  providerReference: string;
  totalMinor: number;
  currency: Currency;
}

export const claimDiscountSchema = z.object({
  productType: z.enum(PRODUCT_TYPES),
});
export type ClaimDiscountInput = z.infer<typeof claimDiscountSchema>;

export interface DiscountView {
  code: string;
  productType: ProductType | null;
  percentOff: number;
  expiresAt: string;
}

export interface OrderStatusEventView {
  status: OrderStatus;
  note: string | null;
  source: string;
  createdAt: string;
}

export interface OrderItemView {
  id: string;
  productId: string;
  productName: string;
  productSlug: string;
  variantName: string | null;
  size: string;
  quantity: number;
  unitPriceMinor: number;
  thumbnailUrl: string | null;
}

export interface ShipmentView {
  id: string;
  provider: string;
  trackingNumber: string | null;
  labelUrl: string | null;
  status: ShipmentStatus;
  estimatedDeliveryDate: string | null;
  events: { status: ShipmentStatus; description: string; occurredAt: string }[];
}

export interface OrderView {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  currency: Currency;
  subtotalMinor: number;
  discountMinor: number;
  discountCode: string | null;
  shippingMinor: number;
  totalMinor: number;
  paymentProvider: string;
  createdAt: string;
  items: OrderItemView[];
  shipment: ShipmentView | null;
  statusHistory: OrderStatusEventView[];
  shippingAddress: AddressInput;
}

export const createProductSchema = z
  .object({
    name: z.string().min(1).max(160),
    slug: z.string().min(1).max(160).regex(/^[a-z0-9-]+$/),
    description: z.string().max(4000).default(''),
    productType: z.enum(PRODUCT_TYPES),
    category: z.enum(PRODUCT_CATEGORIES),
    gender: z.enum(GENDERS),
    basePriceMinor: z.number().int().positive(),
    currency: z.enum(SUPPORTED_CURRENCIES).default('EUR'),
    availableSizes: z.array(z.enum(CLOTHING_SIZES)).min(1),
    fulfillmentType: z.enum(['STOCKED', 'MADE_TO_ORDER']).default('STOCKED'),
    materials: z.array(z.string().max(60)).default([]),
    careInstructions: z.string().max(1000).optional(),
    easeOverride: z
      .object({ bustCm: z.number(), waistCm: z.number(), hipsCm: z.number() })
      .partial()
      .optional(),
    weightGrams: z.number().int().positive().default(500),
  })
  .refine(
    (input) =>
      (PRODUCT_TYPE_CATEGORIES[input.productType] as readonly ProductCategory[]).includes(
        input.category,
      ),
    { message: 'category does not belong to the selected productType', path: ['category'] },
  );
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const MAX_BATCH_PRODUCTS = 30;

export const batchProductItemSchema = createProductSchema
  .innerType()
  .extend({
    colorName: z.string().min(1).max(60).default('Default'),
    colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#111111'),
    stock: z.number().int().min(0).max(100_000).default(0),
  })
  .refine(
    (input) =>
      (PRODUCT_TYPE_CATEGORIES[input.productType] as readonly ProductCategory[]).includes(
        input.category,
      ),
    { message: 'category does not belong to the selected productType', path: ['category'] },
  );
export type BatchProductItemInput = z.infer<typeof batchProductItemSchema>;

export const batchProductsSchema = z.object({
  items: z.array(batchProductItemSchema).min(1).max(MAX_BATCH_PRODUCTS),
  runAt: z.string().datetime({ offset: true }).optional(),
});

export interface BatchProductResult {
  row: number;
  slug: string;
  productId: string | null;
  garmentId: string | null;
  error: string | null;
}

export interface BatchProductStatus {
  productId: string;
  slug: string;
  name: string;
  isPublished: boolean;
  generationStatus: GenerationStatus | null;
  failureReason: string | null;
}

export const updateProductSchema = createProductSchema
  .innerType()
  .partial()
  .extend({ isPublished: z.boolean().optional() })
  .refine(
    (input) =>
      !input.productType ||
      !input.category ||
      (PRODUCT_TYPE_CATEGORIES[input.productType] as readonly ProductCategory[]).includes(
        input.category,
      ),
    { message: 'category does not belong to the selected productType', path: ['category'] },
  );
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export interface AdminProductVariantView {
  id: string;
  name: string;
  colorName: string;
  colorHex: string;
  patternName: string | null;
  priceDeltaMinor: number;
  isPublished: boolean;
}

export interface AdminProductListItemView {
  id: string;
  slug: string;
  name: string;
  productType: ProductType;
  category: string;
  gender: Gender;
  basePriceMinor: number;
  currency: Currency;
  thumbnailUrl: string | null;
  isPublished: boolean;
  fulfillmentType: FulfillmentType;
  updatedAt: string;
}

export interface AdminProductDetailView extends AdminProductListItemView {
  description: string;
  availableSizes: string[];
  materials: string[];
  careInstructions: string | null;
  weightGrams: number;
  images: { key: string; url: string }[];
  variants: AdminProductVariantView[];
  garment3D: Garment3DView | null;
  avatarModelUrls: Record<Gender, string> | null;
}

export const adminProductQuerySchema = z.object({
  search: z.string().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(30),
});
export type AdminProductQuery = z.infer<typeof adminProductQuerySchema>;

export const adjustInventorySchema = z.object({
  sku: z.string().min(1).max(80),
  delta: z.number().int(),
  reason: z.string().min(1).max(200),
});
export type AdjustInventoryInput = z.infer<typeof adjustInventorySchema>;

export const PRODUCT_EVENT_KINDS = ['CARD_CLICK', 'PAGE_VIEW'] as const;
export type ProductEventKind = (typeof PRODUCT_EVENT_KINDS)[number];

export const trackProductEventSchema = z.object({
  productId: z.string().uuid(),
  kind: z.enum(PRODUCT_EVENT_KINDS),
  anonId: z.string().min(8).max(64),
});
export type TrackProductEventInput = z.infer<typeof trackProductEventSchema>;

export const productStatsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ProductStatsQuery = z.infer<typeof productStatsQuerySchema>;

export interface ProductStatsRow {
  productId: string;
  slug: string;
  name: string;
  productType: ProductType;
  isPublished: boolean;
  cardClicks: number;
  pageViews: number;
  uniqueVisitors: number;
  clickThroughRate: number | null;
}

export interface ProductStatsView {
  days: number;
  totals: {
    cardClicks: number;
    pageViews: number;
    trackedProducts: number;
  };
  rows: ProductStatsRow[];
}
