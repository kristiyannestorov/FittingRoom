export const CLOTHING_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'] as const;
export type ClothingSize = (typeof CLOTHING_SIZES)[number];

export interface SizeSpec {
  size: ClothingSize;
  euSize: number;
  bustCm: number;
  waistCm: number;
  hipsCm: number;
}

export const SIZE_CHART: readonly SizeSpec[] = [
  { size: 'XS', euSize: 34, bustCm: 80, waistCm: 62, hipsCm: 88 },
  { size: 'S', euSize: 36, bustCm: 84, waistCm: 66, hipsCm: 92 },
  { size: 'M', euSize: 38, bustCm: 88, waistCm: 70, hipsCm: 96 },
  { size: 'L', euSize: 40, bustCm: 94, waistCm: 76, hipsCm: 102 },
  { size: 'XL', euSize: 42, bustCm: 100, waistCm: 82, hipsCm: 108 },
  { size: 'XXL', euSize: 44, bustCm: 108, waistCm: 90, hipsCm: 116 },
];

export function getSizeSpec(size: ClothingSize): SizeSpec {
  const spec = SIZE_CHART.find((s) => s.size === size);
  if (!spec) throw new Error(`Unknown size: ${size}`);
  return spec;
}

export const PRODUCT_TYPES = [
  'DRESS',
  'T_SHIRT',
  'SHORTS',
  'PANTS',
  'LONG_SLEEVE',
  'HOODIE',
] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const PRODUCT_CATEGORIES = [
  'BODYCON',
  'A_LINE',
  'WRAP',
  'MAXI',
  'SLIP',
  'BALL_GOWN',
  'SHIFT',
  'CREW_NECK',
  'V_NECK',
  'GRAPHIC',
  'POLO',
  'HENLEY',
  'WAFFLE_KNIT',
  'BUTTON_UP',
  'PULLOVER',
  'ZIP_UP',
  'CHINO',
  'DENIM',
  'ATHLETIC',
] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export const PRODUCT_TYPE_CATEGORIES: Record<ProductType, readonly ProductCategory[]> = {
  DRESS: ['BODYCON', 'A_LINE', 'WRAP', 'MAXI', 'SLIP', 'BALL_GOWN', 'SHIFT'],
  T_SHIRT: ['CREW_NECK', 'V_NECK', 'GRAPHIC', 'POLO'],
  LONG_SLEEVE: ['HENLEY', 'WAFFLE_KNIT', 'BUTTON_UP', 'POLO'],
  HOODIE: ['PULLOVER', 'ZIP_UP', 'GRAPHIC'],
  SHORTS: ['CHINO', 'DENIM', 'ATHLETIC'],
  PANTS: ['CHINO', 'DENIM', 'ATHLETIC'],
};

export function categoriesForType(productType: ProductType): readonly ProductCategory[] {
  return PRODUCT_TYPE_CATEGORIES[productType];
}

export interface EaseAllowance {
  bustCm: number;
  waistCm: number;
  hipsCm: number;
}

export const CATEGORY_EASE: Record<ProductCategory, EaseAllowance> = {
  BODYCON: { bustCm: -4, waistCm: -4, hipsCm: -3 },
  A_LINE: { bustCm: 4, waistCm: 3, hipsCm: 10 },
  WRAP: { bustCm: 5, waistCm: 4, hipsCm: 8 },
  MAXI: { bustCm: 4, waistCm: 4, hipsCm: 9 },
  SLIP: { bustCm: 2, waistCm: 3, hipsCm: 4 },
  BALL_GOWN: { bustCm: 3, waistCm: 2, hipsCm: 25 },
  SHIFT: { bustCm: 6, waistCm: 10, hipsCm: 8 },
  CREW_NECK: { bustCm: 10, waistCm: 14, hipsCm: 14 },
  V_NECK: { bustCm: 9, waistCm: 13, hipsCm: 13 },
  GRAPHIC: { bustCm: 12, waistCm: 16, hipsCm: 16 },
  POLO: { bustCm: 10, waistCm: 12, hipsCm: 12 },
  HENLEY: { bustCm: 9, waistCm: 12, hipsCm: 12 },
  WAFFLE_KNIT: { bustCm: 6, waistCm: 8, hipsCm: 8 },
  BUTTON_UP: { bustCm: 8, waistCm: 10, hipsCm: 10 },
  PULLOVER: { bustCm: 16, waistCm: 20, hipsCm: 20 },
  ZIP_UP: { bustCm: 15, waistCm: 18, hipsCm: 18 },
  CHINO: { bustCm: 0, waistCm: 4, hipsCm: 6 },
  DENIM: { bustCm: 0, waistCm: 2, hipsCm: 4 },
  ATHLETIC: { bustCm: 0, waistCm: 8, hipsCm: 10 },
};

