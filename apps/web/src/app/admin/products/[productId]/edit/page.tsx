'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CLOTHING_SIZES,
  type AdminProductDetailView,
  PRODUCT_TYPES,
  PRODUCT_TYPE_CATEGORIES,
  type ClothingSize,
  type Gender,
  type ProductCategory,
  type ProductType,
} from '@zed/contracts';
import { adminApi } from '@/lib/api/admin';
import { Spinner } from '@/components/ui/state';
import type { OutfitPiece } from '@/components/fitting-room/GarmentViewer3D';
import { GarmentViewer3D } from '@/components/fitting-room/LazyGarmentViewer3D';

export default function EditProductPage() {
  const params = useParams<{ productId: string }>();
  const productId = params.productId;
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: product, isLoading } = useQuery({
    queryKey: ['admin-product', productId],
    queryFn: () => adminApi.products.get(productId),
  });

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [productType, setProductType] = useState<ProductType>('DRESS');
  const [category, setCategory] = useState<ProductCategory>(PRODUCT_TYPE_CATEGORIES.DRESS[0]);
  const [gender, setGender] = useState<Gender>('FEMALE');
  const [priceMajor, setPriceMajor] = useState('0.00');
  const [sizes, setSizes] = useState<ClothingSize[]>([]);
  const [fulfillmentType, setFulfillmentType] = useState<'STOCKED' | 'MADE_TO_ORDER'>('STOCKED');
  const [materials, setMaterials] = useState('');
  const [careInstructions, setCareInstructions] = useState('');
  const [isPublished, setIsPublished] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!product || hydrated) return;
    setName(product.name);
    setSlug(product.slug);
    setDescription(product.description);
    setProductType(product.productType);
    setCategory(product.category as ProductCategory);
    setGender(product.gender);
    setPriceMajor((product.basePriceMinor / 100).toFixed(2));
    setSizes(product.availableSizes as ClothingSize[]);
    setFulfillmentType(product.fulfillmentType);
    setMaterials(product.materials.join(', '));
    setCareInstructions(product.careInstructions ?? '');
    setIsPublished(product.isPublished);
    setHydrated(true);
  }, [product, hydrated]);

  const selectProductType = (type: ProductType) => {
    setProductType(type);
    setCategory(PRODUCT_TYPE_CATEGORIES[type][0]);
  };

  const detection = useQuery({
    queryKey: ['classify-product', productId, productType],
    queryFn: () => adminApi.garmentGeneration.classifyProduct(productId, productType),
    enabled: hydrated && Boolean(product && (product.images.length > 0 || product.garment3D)),
    staleTime: Infinity,
    retry: false,
  });
  const detected = detection.data?.productType === productType ? detection.data : undefined;
  const detectedCategory = detected?.categories[0];
  const detectedType = detection.data?.productTypes[0];

  const toggleSize = (size: ClothingSize) =>
    setSizes((current) => (current.includes(size) ? current.filter((s) => s !== size) : [...current, size]));

  const save = useMutation({
    mutationFn: () =>
      adminApi.products.update(productId, {
        name,
        slug,
        description,
        productType,
        category,
        gender,
        basePriceMinor: Math.round(Number(priceMajor) * 100),
        availableSizes: sizes,
        fulfillmentType,
        materials: materials
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean),
        careInstructions: careInstructions || undefined,
        isPublished,
      }),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['admin-products'] });
      queryClient.setQueryData(['admin-product', productId], updated);
    },
  });

  const togglePublish = useMutation({
    mutationFn: (published: boolean) => adminApi.products.publish(productId, published),
    onSuccess: (updated) => {
      setIsPublished(updated.isPublished);
      queryClient.invalidateQueries({ queryKey: ['admin-products'] });
      queryClient.invalidateQueries({ queryKey: ['admin-product', productId] });
    },
  });

  const setProduct = (updated: AdminProductDetailView) =>
    queryClient.setQueryData(['admin-product', productId], updated);

  const uploadImages = useMutation({
    mutationFn: (files: File[]) => adminApi.products.addImages(productId, files),
    onSuccess: (updated) => {
      setProduct(updated);
      queryClient.invalidateQueries({ queryKey: ['admin-products'] });
    },
  });

  const deleteImage = useMutation({
    mutationFn: (key: string) => adminApi.products.removeImage(productId, key),
    onSuccess: (updated) => {
      setProduct(updated);
      queryClient.invalidateQueries({ queryKey: ['admin-products'] });
    },
  });

  const toggleVariantPublish = useMutation({
    mutationFn: ({ variantId, published }: { variantId: string; published: boolean }) =>
      adminApi.products.publishVariant(variantId, published),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-product', productId] }),
  });

  if (isLoading || !product) {
    return <Spinner label="Loading product…" />;
  }

  const generated = product.garment3D?.generationStatus === 'COMPLETED' ? product.garment3D : null;
  const previewVariant = product.variants[0];
  const garmentPiece: OutfitPiece | null =
    generated || previewVariant
      ? {
          productType: product.productType,
          garmentTextureUrl: generated?.textureUrl ?? undefined,
          garmentMeshUrl: generated?.textureMeshUrl ?? undefined,
          garmentMeshUrls: generated?.textureMeshUrls ?? undefined,
          garmentMeshName: generated?.textureMeshName ?? undefined,
          garmentUrl: generated?.modelUrl ?? undefined,
          garmentColorHex: previewVariant?.colorHex,
        }
      : null;
  const garmentReady = Boolean(product.avatarModelUrls && garmentPiece);

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Edit product</h1>
        <button
          type="button"
          onClick={() => router.push('/admin/products')}
          className="text-sm text-black/50 hover:underline"
        >
          Back to products
        </button>
      </div>

      <div className="mb-6 flex items-center justify-between rounded-lg border border-black/10 p-4 text-sm">
        <span>
          Visibility: <span className="font-medium">{isPublished ? 'Visible to customers' : 'Hidden'}</span>
        </span>
        <button
          type="button"
          disabled={togglePublish.isPending}
          onClick={() => togglePublish.mutate(!isPublished)}
          className={`rounded-full px-4 py-1.5 text-xs font-medium disabled:opacity-40 ${
            isPublished ? 'bg-green-600/10 text-green-700' : 'bg-black/10 text-black/60'
          }`}
        >
          {isPublished ? 'Hide product' : 'Publish product'}
        </button>
      </div>

      <div className="mb-6">
        <p className="mb-2 text-sm font-medium">Photos</p>
        <div className="grid grid-cols-3 gap-2">
          {product.images.map((image, index) => (
            <div key={image.key} className="group relative aspect-[3/4] overflow-hidden rounded-lg bg-black/5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image.url} alt={`${product.name} photo ${index + 1}`} className="h-full w-full object-cover" />
              {index === 0 && (
                <span className="absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">
                  Main
                </span>
              )}
              <button
                type="button"
                disabled={deleteImage.isPending}
                onClick={() => deleteImage.mutate(image.key)}
                className="absolute right-1 top-1 rounded bg-white/90 px-1.5 py-0.5 text-xs text-red-600 opacity-0 group-hover:opacity-100 disabled:opacity-40"
              >
                Remove
              </button>
            </div>
          ))}
          <label className="flex aspect-[3/4] cursor-pointer items-center justify-center rounded-lg border border-dashed border-black/30 text-center text-xs text-black/50 hover:bg-black/5">
            {uploadImages.isPending ? 'Uploading…' : '+ Add photos'}
            <input
              type="file"
              accept="image/*"
              multiple
              hidden
              disabled={uploadImages.isPending}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = '';
                if (files.length > 0) uploadImages.mutate(files);
              }}
            />
          </label>
        </div>
        {(uploadImages.isError || deleteImage.isError) && (
          <p className="mt-2 text-sm text-red-600">
            {((uploadImages.error ?? deleteImage.error) as Error).message}
          </p>
        )}
      </div>

      <div className="mb-6">
        <p className="mb-2 text-sm font-medium">3D model</p>
        {garmentReady ? (
          <GarmentViewer3D
            avatarUrls={product.avatarModelUrls!}
            initialBody={product.gender}
            lockBody
            pieces={[garmentPiece!]}
          />
        ) : (
          <div className="flex aspect-square items-center justify-center rounded-xl bg-black/5 text-center text-sm text-black/40">
            {product.garment3D
              ? `Garment status: ${product.garment3D.generationStatus}${
                  product.garment3D.failureReason ? `: ${product.garment3D.failureReason}` : ''
                }`
              : 'No 3D garment generated yet for this product.'}
          </div>
        )}
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <label className="text-sm">
          Name
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-lg border border-black/20 px-3 py-2"
          />
        </label>
        <label className="text-sm">
          Slug
          <input
            required
            pattern="[a-z0-9\-]+"
            title="Lowercase letters, numbers and hyphens only"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="mt-1 w-full rounded-lg border border-black/20 px-3 py-2"
          />
        </label>
        <label className="text-sm">
          Description
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-1 w-full rounded-lg border border-black/20 px-3 py-2"
            rows={3}
          />
        </label>
        <label className="text-sm">
          Product type
          <select
            value={productType}
            onChange={(e) => selectProductType(e.target.value as ProductType)}
            className="mt-1 w-full rounded-lg border border-black/20 px-3 py-2"
          >
            {PRODUCT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Category
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as ProductCategory)}
            className="mt-1 w-full rounded-lg border border-black/20 px-3 py-2"
          >
            {PRODUCT_TYPE_CATEGORIES[productType].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          {detection.isFetching && (
            <span className="mt-1 block text-xs text-black/50">Detecting from the product photo…</span>
          )}
          {detection.isError && (
            <span className="mt-1 block text-xs text-red-600">
              Could not detect the category: {(detection.error as Error).message}
            </span>
          )}
          {detected && detectedCategory && !detection.isFetching && (
            <span className="mt-1 block text-xs text-black/60">
              Detected from the photo: {detectedCategory.label} {Math.round(detectedCategory.confidence * 100)}%
              {detectedCategory.label !== category && (
                <>
                  {' '}
                  <button type="button" onClick={() => setCategory(detectedCategory.label)} className="underline">
                    Use {detectedCategory.label}
                  </button>{' '}
                  <span className="text-black/40">(save, then bake again to get its shape)</span>
                </>
              )}
            </span>
          )}
          {detectedType && detectedType.label !== productType && detectedType.confidence >= 0.6 && (
            <span className="mt-1 block text-xs text-amber-700">
              The photo looks like a {detectedType.label} ({Math.round(detectedType.confidence * 100)}%), not a{' '}
              {productType}.{' '}
              <button type="button" onClick={() => selectProductType(detectedType.label)} className="underline">
                Switch to {detectedType.label}
              </button>
            </span>
          )}
        </label>
        <label className="text-sm">
          Gender
          <select
            value={gender}
            onChange={(e) => setGender(e.target.value as Gender)}
            className="mt-1 w-full rounded-lg border border-black/20 px-3 py-2"
          >
            <option value="FEMALE">Female</option>
            <option value="MALE">Male</option>
          </select>
        </label>
        <label className="text-sm">
          Base price (EUR)
          <input
            type="number"
            step="0.01"
            value={priceMajor}
            onChange={(e) => setPriceMajor(e.target.value)}
            className="mt-1 w-full rounded-lg border border-black/20 px-3 py-2"
          />
        </label>
        <div className="text-sm">
          Sizes
          <div className="mt-1 flex gap-2">
            {CLOTHING_SIZES.map((s) => (
              <button
                type="button"
                key={s}
                onClick={() => toggleSize(s)}
                className={`rounded-md border px-3 py-1 text-xs ${
                  sizes.includes(s) ? 'border-ink bg-ink text-paper' : 'border-black/20'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <label className="text-sm">
          Fulfillment
          <select
            value={fulfillmentType}
            onChange={(e) => setFulfillmentType(e.target.value as 'STOCKED' | 'MADE_TO_ORDER')}
            className="mt-1 w-full rounded-lg border border-black/20 px-3 py-2"
          >
            <option value="STOCKED">Stocked</option>
            <option value="MADE_TO_ORDER">Made to order</option>
          </select>
        </label>
        <label className="text-sm">
          Materials (comma separated)
          <input
            value={materials}
            onChange={(e) => setMaterials(e.target.value)}
            placeholder="e.g. cotton, elastane"
            className="mt-1 w-full rounded-lg border border-black/20 px-3 py-2"
          />
        </label>
        <label className="text-sm">
          Care instructions
          <textarea
            value={careInstructions}
            onChange={(e) => setCareInstructions(e.target.value)}
            className="mt-1 w-full rounded-lg border border-black/20 px-3 py-2"
            rows={2}
          />
        </label>

        <button
          type="submit"
          disabled={save.isPending}
          className="rounded-md bg-ink px-6 py-3 text-sm font-medium text-paper disabled:opacity-40"
        >
          {save.isPending ? 'Saving…' : 'Save changes'}
        </button>
        {save.isSuccess && <p className="text-sm text-green-700">Saved.</p>}
        {save.isError && <p className="text-sm text-red-600">{(save.error as Error).message}</p>}
      </form>

      {product.variants.length > 0 && (
        <div className="mt-8 rounded-lg border border-black/10 p-4 text-sm">
          <p className="mb-3 font-medium">Variants</p>
          <div className="space-y-2">
            {product.variants.map((variant) => (
              <div key={variant.id} className="flex items-center justify-between rounded-md border border-black/10 px-3 py-2">
                <span className="flex items-center gap-2">
                  <span
                    className="h-4 w-4 rounded-full border border-black/10"
                    style={{ backgroundColor: variant.colorHex }}
                  />
                  {variant.name}, {variant.colorName}
                </span>
                <button
                  type="button"
                  disabled={toggleVariantPublish.isPending}
                  onClick={() =>
                    toggleVariantPublish.mutate({ variantId: variant.id, published: !variant.isPublished })
                  }
                  className={`rounded-full px-3 py-1 text-xs font-medium disabled:opacity-40 ${
                    variant.isPublished ? 'bg-green-600/10 text-green-700' : 'bg-black/10 text-black/50'
                  }`}
                >
                  {variant.isPublished ? 'Visible' : 'Hidden'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
