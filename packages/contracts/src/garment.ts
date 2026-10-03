import type { ClothingSize, ProductCategory, ProductType } from './sizing';
import type { Gender, GenerationStatus } from './enums';

export interface GarmentMeasurementSpec {
  size: ClothingSize;
  chestCm: number | null;
  waistCm: number | null;
  shoulderCm: number | null;
  lengthCm: number | null;
  sleeveLengthCm: number | null;
}

export interface Garment3DView {
  id: string;
  modelUrl: string | null;
  textureUrl: string | null;
  textureMeshUrl: string | null;
  textureMeshUrls: Record<Gender, string> | null;
  textureMeshName: string | null;
  previewUrl: string | null;
  generationStatus: GenerationStatus;
  generationProvider: string;
  confidenceScore: number | null;
  failureReason: string | null;
  measurements: GarmentMeasurementSpec[];
}

export interface GarmentClassificationScore<T extends string> {
  label: T;
  confidence: number;
}

export interface GarmentClassification {
  productType: ProductType;
  productTypes: GarmentClassificationScore<ProductType>[];
  categories: GarmentClassificationScore<ProductCategory>[];
}

export interface GenerateGarment3DResponse {
  garmentId: string;
  jobId: string;
  status: 'processing';
}

export const GARMENT_SLOTS = ['TOP', 'BOTTOM', 'FULL_BODY'] as const;
export type GarmentSlot = (typeof GARMENT_SLOTS)[number];

export const PRODUCT_TYPE_GARMENT_SLOTS: Record<ProductType, GarmentSlot> = {
  T_SHIRT: 'TOP',
  LONG_SLEEVE: 'TOP',
  HOODIE: 'TOP',
  SHORTS: 'BOTTOM',
  PANTS: 'BOTTOM',
  DRESS: 'FULL_BODY',
};

export function garmentSlotForProductType(productType: ProductType): GarmentSlot {
  return PRODUCT_TYPE_GARMENT_SLOTS[productType];
}

export const GARMENT_SLOT_REGIONS: Record<GarmentSlot, readonly ('TORSO' | 'LEGS')[]> = {
  TOP: ['TORSO'],
  BOTTOM: ['LEGS'],
  FULL_BODY: ['TORSO', 'LEGS'],
};

export function garmentSlotsConflict(a: GarmentSlot, b: GarmentSlot): boolean {
  return GARMENT_SLOT_REGIONS[a].some((region) => GARMENT_SLOT_REGIONS[b].includes(region));
}
