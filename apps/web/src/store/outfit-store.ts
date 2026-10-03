import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  garmentSlotForProductType,
  garmentSlotsConflict,
  type ClothingSize,
  type ProductType,
} from '@zed/contracts';

export interface OutfitPieceRef {
  slug: string;
  productType: ProductType;
  name: string;
  variantId: string | null;
  size: ClothingSize | null;
}

interface OutfitState {
  pieces: OutfitPieceRef[];
  wear: (piece: OutfitPieceRef) => void;
  removeBySlug: (slug: string) => void;
  clear: () => void;
}

export const useOutfitStore = create<OutfitState>()(
  persist(
    (set) => ({
      pieces: [],
      wear: (piece) =>
        set((state) => {
          const slot = garmentSlotForProductType(piece.productType);
          const kept = state.pieces.filter(
            (existing) =>
              existing.slug !== piece.slug &&
              !garmentSlotsConflict(garmentSlotForProductType(existing.productType), slot),
          );
          return { pieces: [...kept, piece] };
        }),
      removeBySlug: (slug) =>
        set((state) => ({ pieces: state.pieces.filter((p) => p.slug !== slug) })),
      clear: () => set({ pieces: [] }),
    }),
    { name: 'zed-outfit' },
  ),
);
