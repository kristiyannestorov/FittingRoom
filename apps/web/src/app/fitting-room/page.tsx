'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import type { ClothingSize, ProductDetailView } from '@zed/contracts';
import { productsApi } from '@/lib/api/products';
import { cartApi } from '@/lib/api/cart';
import { useAuthStore } from '@/store/auth-store';
import { useOutfitStore, type OutfitPieceRef } from '@/store/outfit-store';
import { formatPriceMinor } from '@/lib/format';
import { GarmentViewer3D } from '@/components/fitting-room/LazyGarmentViewer3D';
import { outfitPieceFor } from '@/components/fitting-room/outfit';
import { TryOnDialog, type TryOnDialogPiece } from '@/components/try-on-dialog';

const TYPE_LABEL: Record<string, string> = {
  DRESS: 'Dress',
  T_SHIRT: 'T-Shirt',
  SHORTS: 'Shorts',
  PANTS: 'Pants',
  LONG_SLEEVE: 'Long Sleeve',
  HOODIE: 'Hoodie',
};

export default function FittingRoomPage() {
  const outfit = useOutfitStore((s) => s.pieces);
  const removeBySlug = useOutfitStore((s) => s.removeBySlug);
  const clear = useOutfitStore((s) => s.clear);
  const tokens = useAuthStore((s) => s.tokens);
  const queryClient = useQueryClient();

  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const [addedMessage, setAddedMessage] = useState<string | null>(null);
  const [tryingOn, setTryingOn] = useState(false);

  const results = useQueries({
    queries: outfit.map((piece) => ({
      queryKey: ['product', piece.slug],
      queryFn: () => productsApi.get(piece.slug),
    })),
  });

  const loading = results.some((r) => r.isLoading);
  const worn = outfit
    .map((ref, i) => ({ ref, product: results[i]?.data }))
    .filter((entry): entry is { ref: OutfitPieceRef; product: ProductDetailView } =>
      Boolean(entry.product),
    );

  const avatarUrls = worn.find((w) => w.product.avatarModelUrls)?.product.avatarModelUrls ?? null;
  const initialBody = worn[0]?.product.gender;
  const singleGenderOutfit =
    worn.length > 0 && worn.every((w) => w.product.gender === initialBody);
  const viewerPieces = worn
    .map((w) => outfitPieceFor(w.product, { variantId: w.ref.variantId, size: w.ref.size }))
    .filter((piece): piece is NonNullable<typeof piece> => Boolean(piece));

  const totalMinor = worn.reduce((sum, w) => sum + w.product.basePriceMinor, 0);
  const currency = worn[0]?.product.currency ?? 'EUR';

  const tryOnPieces: TryOnDialogPiece[] = worn
    .filter((w) => w.product.tryOnAvailable)
    .map((w) => ({ slug: w.product.slug, name: w.product.name, variantId: w.ref.variantId }));

  const buyable = worn.filter((w) => w.ref.size && w.product.inStockSizes.includes(w.ref.size));
  const canBuyAll = worn.length > 0 && buyable.length === worn.length;

  const addAll = useMutation({
    mutationFn: async () => {
      let cart = null;
      for (const w of buyable) {
        cart = await cartApi.add({
          productId: w.product.id,
          variantId: w.ref.variantId,
          size: w.ref.size as ClothingSize,
          quantity: 1,
        });
      }
      return cart;
    },
    onSuccess: (cart) => {
      if (cart) queryClient.setQueryData(['cart'], cart);
      setAddedMessage('Outfit added to cart.');
      setTimeout(() => setAddedMessage(null), 2500);
    },
  });

  if (!hydrated) return <p className="text-black/50">Loading…</p>;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Fitting room</h1>
        <p className="mt-1 text-sm text-black/60">
          Everything you&apos;ve put on the avatar, worn together.
        </p>
      </div>

      {outfit.length === 0 ? (
        <div className="rounded-xl border border-dashed border-black/20 p-10 text-center">
          <p className="text-sm text-black/60">
            Nothing on the avatar yet. Open a product and choose{' '}
            <span className="font-medium">Wear this</span> to build an outfit: a top and a
            bottom render together here.
          </p>
          <Link
            href="/products"
            className="mt-4 inline-block rounded-md border border-black/20 px-4 py-2 text-sm hover:bg-black/5"
          >
            Browse the catalog
          </Link>
        </div>
      ) : (
        <div className="grid gap-10 lg:grid-cols-2">
          <div>
            {loading ? (
              <div className="flex aspect-square items-center justify-center rounded-xl bg-black/5 text-sm text-black/40">
                Loading the look…
              </div>
            ) : avatarUrls && viewerPieces.length > 0 ? (
              <GarmentViewer3D
                avatarUrls={avatarUrls}
                initialBody={initialBody}
                lockBody={singleGenderOutfit}
                pieces={viewerPieces}
              />
            ) : (
              <div className="flex aspect-square items-center justify-center rounded-xl bg-black/5 p-8 text-center text-sm text-black/40">
                None of these pieces can be rendered on the avatar yet.
              </div>
            )}
          </div>

          <div className="flex flex-col gap-4">
            {worn.map(({ ref, product }) => (
              <div
                key={ref.slug}
                className="flex items-center gap-4 rounded-xl border border-black/10 p-3"
              >
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-md bg-black/5">
                  {product.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={product.thumbnailUrl}
                      alt={product.name}
                      className="h-full w-full object-cover"
                    />
                  ) : null}
                </div>
                <div className="flex-1">
                  <Link href={`/products/${product.slug}`} className="text-sm font-medium hover:text-accent">
                    {product.name}
                  </Link>
                  <p className="text-xs text-black/50">
                    {TYPE_LABEL[product.productType] ?? product.productType}
                    {ref.size ? ` · size ${ref.size}` : ' · no size chosen'}
                  </p>
                  <p className="text-xs text-black/60">
                    {formatPriceMinor(product.basePriceMinor, product.currency)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => removeBySlug(ref.slug)}
                  className="rounded-md border border-black/20 px-3 py-1 text-xs hover:bg-black/5"
                >
                  Take off
                </button>
              </div>
            ))}

            {worn.length > 0 && (
              <div className="flex items-center justify-between border-t border-black/10 pt-4 text-sm">
                <span className="text-black/60">Outfit total</span>
                <span className="font-medium">{formatPriceMinor(totalMinor, currency)}</span>
              </div>
            )}

            {tryOnPieces.length > 0 && (
              <button
                type="button"
                onClick={() => setTryingOn(true)}
                className="rounded-md border border-black/20 px-6 py-3 text-sm font-medium hover:bg-black/5"
              >
                {tryOnPieces.length > 1 ? 'Try this outfit on your photo' : 'Try it on with your photo'}
              </button>
            )}
            {tryingOn && <TryOnDialog pieces={tryOnPieces} onClose={() => setTryingOn(false)} />}

            <button
              type="button"
              disabled={!tokens || !canBuyAll || addAll.isPending}
              onClick={() => addAll.mutate()}
              className="rounded-md bg-ink px-6 py-3 text-sm font-medium text-paper disabled:opacity-40"
            >
              {addAll.isPending ? 'Adding…' : 'Add outfit to cart'}
            </button>
            {addedMessage && <p className="text-sm text-green-700">{addedMessage}</p>}
            {!tokens && <p className="text-sm text-black/50">Sign in to add items to your cart.</p>}
            {tokens && !canBuyAll && worn.length > 0 && (
              <p className="text-sm text-black/50">
                Pick an in-stock size for every piece on its product page to buy the whole look.
              </p>
            )}

            <button
              type="button"
              onClick={clear}
              className="self-start text-xs text-black/50 underline hover:text-black"
            >
              Clear the outfit
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
