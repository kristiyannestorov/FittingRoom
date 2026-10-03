'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  garmentSlotForProductType,
  garmentSlotsConflict,
  type ClothingSize,
} from '@zed/contracts';
import { productsApi } from '@/lib/api/products';
import { cartApi } from '@/lib/api/cart';
import { useAuthStore } from '@/store/auth-store';
import { useOutfitStore } from '@/store/outfit-store';
import { formatPriceMinor } from '@/lib/format';
import { GarmentViewer3D } from '@/components/fitting-room/LazyGarmentViewer3D';
import { outfitPieceFor } from '@/components/fitting-room/outfit';
import { PersonalizedOfferBanner } from '@/components/personalized-offer-banner';
import { TryOnDialog, type TryOnDialogPiece } from '@/components/try-on-dialog';
import { recordProductView } from '@/lib/view-tracking';
import { analyticsApi } from '@/lib/api/analytics';

export default function ProductDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const tokens = useAuthStore((s) => s.tokens);
  const queryClient = useQueryClient();

  const [variantId, setVariantId] = useState<string | undefined>();
  const [size, setSize] = useState<ClothingSize | undefined>();
  const [addedMessage, setAddedMessage] = useState<string | null>(null);
  const [show3D, setShow3D] = useState(false);
  const [withOutfit, setWithOutfit] = useState(true);
  const [tryOnPieces, setTryOnPieces] = useState<TryOnDialogPiece[] | null>(null);

  const outfit = useOutfitStore((s) => s.pieces);
  const wearPiece = useOutfitStore((s) => s.wear);
  const removeFromOutfit = useOutfitStore((s) => s.removeBySlug);

  const { data: product, isLoading } = useQuery({
    queryKey: ['product', slug],
    queryFn: () => productsApi.get(slug),
    enabled: Boolean(slug),
  });

  const [photoIndex, setPhotoIndex] = useState(0);
  const photos = product
    ? product.imageUrls.length > 0
      ? product.imageUrls
      : product.thumbnailUrl
        ? [product.thumbnailUrl]
        : []
    : [];

  const [viewCount, setViewCount] = useState(0);
  useEffect(() => {
    if (!product) return;
    setViewCount(recordProductView(product.productType));
    analyticsApi.trackProductEvent(product.id, 'PAGE_VIEW');
  }, [product]);

  const activeVariantId = variantId ?? product?.variants[0]?.id;
  const activeSize: ClothingSize | undefined =
    size ??
    (product?.inStockSizes[0] as ClothingSize | undefined) ??
    (product?.availableSizes[0] as ClothingSize | undefined);

  const companionRefs = useMemo(() => {
    if (!product) return [];
    const slot = garmentSlotForProductType(product.productType);
    return outfit.filter(
      (piece) =>
        piece.slug !== product.slug &&
        !garmentSlotsConflict(garmentSlotForProductType(piece.productType), slot),
    );
  }, [outfit, product]);

  const companionResults = useQueries({
    queries: companionRefs.map((piece) => ({
      queryKey: ['product', piece.slug],
      queryFn: () => productsApi.get(piece.slug),
    })),
  });

  const isWorn = Boolean(product && outfit.some((piece) => piece.slug === product.slug));

  useEffect(() => {
    if (!product) return;
    const store = useOutfitStore.getState();
    if (!store.pieces.some((piece) => piece.slug === product.slug)) return;
    store.wear({
      slug: product.slug,
      productType: product.productType,
      name: product.name,
      variantId: activeVariantId ?? null,
      size: activeSize ?? null,
    });
  }, [product, activeVariantId, activeSize]);

  const addToCart = useMutation({
    mutationFn: () =>
      cartApi.add({
        productId: product!.id,
        variantId: activeVariantId ?? null,
        size: activeSize!,
        quantity: 1,
      }),
    onSuccess: (cart) => {
      queryClient.setQueryData(['cart'], cart);
      setAddedMessage('Added to cart.');
      setTimeout(() => setAddedMessage(null), 2500);
    },
  });

  if (isLoading) return <p className="text-black/50">Loading…</p>;
  if (!product) return <p className="text-red-600">Product not found.</p>;

  const thisPiece = outfitPieceFor(product, { variantId: activeVariantId, size: activeSize });
  const garmentReady = Boolean(product.avatarModelUrls && thisPiece);

  const companionPieces = companionResults
    .map((result, i) =>
      result.data
        ? outfitPieceFor(result.data, {
            variantId: companionRefs[i].variantId,
            size: companionRefs[i].size,
          })
        : null,
    )
    .filter((piece): piece is NonNullable<typeof piece> => Boolean(piece));

  const viewerPieces = thisPiece
    ? withOutfit
      ? [thisPiece, ...companionPieces]
      : [thisPiece]
    : [];

  const tryOnSelf: TryOnDialogPiece = {
    slug: product.slug,
    name: product.name,
    variantId: activeVariantId,
  };
  const tryOnCompanions = companionResults.flatMap((result, i) =>
    result.data?.tryOnAvailable
      ? [{ slug: result.data.slug, name: result.data.name, variantId: companionRefs[i].variantId }]
      : [],
  );

  return (
    <div>
      <PersonalizedOfferBanner productType={product.productType} viewCount={viewCount} />
      <div className="grid gap-10 lg:grid-cols-2">
      <div>
        {show3D && garmentReady ? (
          <GarmentViewer3D
            avatarUrls={product.avatarModelUrls!}
            initialBody={product.gender}
            lockBody
            pieces={viewerPieces}
          />
        ) : (
          <div>
            <div className="aspect-square overflow-hidden rounded-xl bg-black/5">
              {photos.length > 0 ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={photos[Math.min(photoIndex, photos.length - 1)]}
                  alt={product.name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-sm text-black/40">
                  No image
                </div>
              )}
            </div>
            {photos.length > 1 && (
              <div className="mt-2 flex gap-2 overflow-x-auto">
                {photos.map((url, i) => (
                  <button
                    type="button"
                    key={url}
                    onClick={() => setPhotoIndex(i)}
                    className={`h-16 w-16 shrink-0 overflow-hidden rounded-md border ${
                      i === photoIndex ? 'border-ink' : 'border-transparent opacity-70'
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url} alt="" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {product.tryOnAvailable && (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => setTryOnPieces([tryOnSelf])}
              className="flex-1 rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper hover:opacity-90"
            >
              Try it on with your photo
            </button>
            {tryOnCompanions.length > 0 && (
              <button
                type="button"
                onClick={() => setTryOnPieces([tryOnSelf, ...tryOnCompanions])}
                className="flex-1 rounded-md border border-black/20 px-4 py-2 text-sm font-medium hover:bg-black/5"
              >
                Try on with {tryOnCompanions.map((piece) => piece.name).join(', ')}
              </button>
            )}
          </div>
        )}
        {tryOnPieces && <TryOnDialog pieces={tryOnPieces} onClose={() => setTryOnPieces(null)} />}
        {garmentReady && (
          <>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => setShow3D((v) => !v)}
                className="flex-1 rounded-md border border-black/20 px-4 py-2 text-sm font-medium hover:bg-black/5"
              >
                {show3D ? 'Back to photos' : 'View in 3D'}
              </button>
              <button
                type="button"
                onClick={() =>
                  isWorn
                    ? removeFromOutfit(product.slug)
                    : wearPiece({
                        slug: product.slug,
                        productType: product.productType,
                        name: product.name,
                        variantId: activeVariantId ?? null,
                        size: activeSize ?? null,
                      })
                }
                className={`flex-1 rounded-md px-4 py-2 text-sm font-medium ${
                  isWorn
                    ? 'border border-black/20 hover:bg-black/5'
                    : 'bg-ink text-paper hover:opacity-90'
                }`}
              >
                {isWorn ? 'Take off' : 'Wear this'}
              </button>
            </div>

            {companionRefs.length > 0 ? (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-black/60">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={withOutfit}
                    onChange={(e) => setWithOutfit(e.target.checked)}
                  />
                  Wear with {companionRefs.map((piece) => piece.name).join(', ')}
                </label>
                <Link href="/fitting-room" className="underline hover:text-black">
                  Open fitting room
                </Link>
              </div>
            ) : (
              <p className="mt-3 text-xs text-black/50">
                {isWorn
                  ? 'On the avatar. Add a piece from another category: a top and a bottom render together.'
                  : 'Wear this, then add something from another category to see the full look.'}{' '}
                <Link href="/fitting-room" className="underline hover:text-black">
                  Fitting room
                </Link>
              </p>
            )}
          </>
        )}
      </div>

      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold">{product.name}</h1>
          <p className="mt-1 text-lg text-black/70">
            {formatPriceMinor(product.basePriceMinor, product.currency)}
          </p>
        </div>

        {product.variants.length > 1 && (
          <div>
            <p className="mb-2 text-sm font-medium">Colour</p>
            <div className="flex gap-2">
              {product.variants.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  title={v.colorName}
                  onClick={() => setVariantId(v.id)}
                  className={`h-8 w-8 rounded-full border-2 ${
                    activeVariantId === v.id ? 'border-ink' : 'border-transparent'
                  }`}
                  style={{ backgroundColor: v.colorHex }}
                />
              ))}
            </div>
          </div>
        )}

        <div>
          <p className="mb-2 text-sm font-medium">Size</p>
          <div className="flex flex-wrap gap-2">
            {product.availableSizes.map((s) => {
              const inStock = product.inStockSizes.includes(s);
              return (
                <button
                  key={s}
                  type="button"
                  disabled={!inStock}
                  onClick={() => setSize(s as ClothingSize)}
                  className={`rounded-md border px-4 py-2 text-sm ${
                    activeSize === s ? 'border-ink bg-ink text-paper' : 'border-black/20'
                  } ${!inStock ? 'cursor-not-allowed opacity-40' : ''}`}
                >
                  {s}
                </button>
              );
            })}
          </div>
        </div>

        <button
          type="button"
          disabled={!tokens || !activeSize || !product.inStockSizes.includes(activeSize) || addToCart.isPending}
          onClick={() => addToCart.mutate()}
          className="rounded-md bg-ink px-6 py-3 text-sm font-medium text-paper disabled:opacity-40"
        >
          {addToCart.isPending ? 'Adding…' : 'Add to cart'}
        </button>
        {addedMessage && <p className="text-sm text-green-700">{addedMessage}</p>}
        {!tokens && <p className="text-sm text-black/50">Sign in to add items to your cart.</p>}

        {product.description && <p className="text-sm text-black/70">{product.description}</p>}
        {product.materials.length > 0 && (
          <p className="text-xs text-black/50">Materials: {product.materials.join(', ')}</p>
        )}
      </div>
      </div>
    </div>
  );
}
