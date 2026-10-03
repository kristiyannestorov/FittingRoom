import type { ProductDetailView } from '@zed/contracts';
import type { OutfitPiece } from './GarmentViewer3D';

export const SIZE_SCALE: Record<string, number> = {
  XS: 0.94,
  S: 0.97,
  M: 1,
  L: 1.04,
  XL: 1.08,
  XXL: 1.12,
};

export function outfitPieceFor(
  product: ProductDetailView,
  options: { variantId?: string | null; size?: string | null } = {},
): OutfitPiece | null {
  const variant =
    product.variants.find((v) => v.id === options.variantId) ?? product.variants[0] ?? null;

  const generated = product.garment3D?.generationStatus === 'COMPLETED' ? product.garment3D : null;
  const garmentTextureUrl = generated?.textureUrl ?? undefined;
  const garmentUrl = generated?.modelUrl ?? undefined;
  const garmentColorHex = variant?.colorHex ?? undefined;

  if (!garmentTextureUrl && !garmentUrl && !garmentColorHex) return null;

  return {
    productType: product.productType,
    garmentTextureUrl,
    garmentMeshUrl: generated?.textureMeshUrl ?? undefined,
    garmentMeshUrls: generated?.textureMeshUrls ?? undefined,
    garmentMeshName: generated?.textureMeshName ?? undefined,
    garmentUrl,
    garmentColorHex,
    sizeScale: (options.size ? SIZE_SCALE[options.size] : undefined) ?? 1,
  };
}
