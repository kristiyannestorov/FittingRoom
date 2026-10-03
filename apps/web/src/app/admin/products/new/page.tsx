'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  CLOTHING_SIZES,
  PRODUCT_TYPES,
  PRODUCT_TYPE_CATEGORIES,
  type ClothingSize,
  type GarmentGenerationProviderKey,
  type Gender,
  type ProductCategory,
  type ProductType,
} from '@zed/contracts';
import { adminApi } from '@/lib/api/admin';
import { ApiError } from '@/lib/api-client';

export default function NewProductPage() {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [productType, setProductType] = useState<ProductType>('DRESS');
  const [category, setCategory] = useState<ProductCategory>(PRODUCT_TYPE_CATEGORIES.DRESS[0]);
  const [gender, setGender] = useState<Gender>('FEMALE');
  const [priceMajor, setPriceMajor] = useState('129.00');
  const [sizes, setSizes] = useState<ClothingSize[]>(['XS', 'S', 'M', 'L', 'XL']);
  const [fulfillmentType, setFulfillmentType] = useState<'STOCKED' | 'MADE_TO_ORDER'>('STOCKED');
  const [productId, setProductId] = useState<string | null>(null);
  const [photos, setPhotos] = useState<File[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const photoPreviews = useMemo(() => photos.map((file) => URL.createObjectURL(file)), [photos]);
  useEffect(() => () => photoPreviews.forEach((url) => URL.revokeObjectURL(url)), [photoPreviews]);

  const selectProductType = (type: ProductType) => {
    setProductType(type);
    setCategory(PRODUCT_TYPE_CATEGORIES[type][0]);
  };

  const mainPhoto = photos[0];
  const detection = useQuery({
    queryKey: [
      'classify-garment',
      mainPhoto && `${mainPhoto.name}:${mainPhoto.size}:${mainPhoto.lastModified}`,
      productType,
    ],
    queryFn: () => adminApi.garmentGeneration.classify([mainPhoto!], productType),
    enabled: Boolean(mainPhoto),
    staleTime: Infinity,
    retry: false,
  });
  const detected = mainPhoto ? detection.data : undefined;
  useEffect(() => {
    const best = detected?.categories[0]?.label;
    if (detected?.productType === productType && best && PRODUCT_TYPE_CATEGORIES[productType].includes(best)) {
      setCategory(best);
    }
  }, [detected, productType]);
  const detectedType = detected?.productTypes[0];

  const create = useMutation({
    mutationFn: async () => {
      const product = await adminApi.products.create({
        name,
        slug,
        description,
        productType,
        category,
        gender,
        basePriceMinor: Math.round(Number(priceMajor) * 100),
        currency: 'EUR',
        availableSizes: sizes,
        fulfillmentType,
        materials: [],
        weightGrams: 400,
      });
      if (photos.length > 0) {
        try {
          await adminApi.products.addImages(product.id, photos);
        } catch (err) {
          setPhotoError((err as Error).message);
        }
      }
      return product;
    },
    onSuccess: (product) => setProductId(product.id),
  });

  const addMorePhotos = useMutation({
    mutationFn: (files: File[]) => adminApi.products.addImages(productId!, files),
    onSuccess: () => {
      setPhotoError(null);
      refetch();
    },
    onError: (err) => setPhotoError((err as Error).message),
  });

  const { data: status, refetch } = useQuery({
    queryKey: ['admin-product', productId],
    queryFn: () => adminApi.products.get(productId!),
    enabled: Boolean(productId),
  });

  const publish = useMutation({
    mutationFn: () => adminApi.products.publish(productId!, true),
    onSuccess: () => refetch(),
  });

  const [garmentId, setGarmentId] = useState<string | null>(null);
  const [garmentProvider, setGarmentProvider] = useState<GarmentGenerationProviderKey>('MANUAL');
  const [bakeFront, setBakeFront] = useState<File | null>(null);
  const [bakeBack, setBakeBack] = useState<File | null>(null);
  const generate3D = useMutation({
    mutationFn: (files: File[]) => adminApi.garmentGeneration.generate(productId!, files, garmentProvider),
    onSuccess: ({ garmentId }) => setGarmentId(garmentId),
  });
  const { data: garmentJob } = useQuery({
    queryKey: ['garment-job', garmentId],
    queryFn: () => adminApi.garmentGeneration.status(garmentId!),
    enabled: Boolean(garmentId),
    refetchInterval: (query) =>
      query.state.data?.generationStatus === 'PENDING' || query.state.data?.generationStatus === 'PROCESSING'
        ? 1500
        : false,
  });

  const toggleSize = (size: ClothingSize) =>
    setSizes((current) => (current.includes(size) ? current.filter((s) => s !== size) : [...current, size]));

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="mb-6 text-2xl font-semibold">Add a product</h1>

      {!productId ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
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
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
              placeholder="e.g. midnight-wrap-dress"
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
            {!mainPhoto && (
              <span className="mt-1 block text-xs text-black/50">
                Add a photo below and the category is detected from it.
              </span>
            )}
            {mainPhoto && detection.isFetching && (
              <span className="mt-1 block text-xs text-black/50">Detecting from the first photo…</span>
            )}
            {mainPhoto && detection.isError && (
              <span className="mt-1 block text-xs text-red-600">
                Could not detect the category: {(detection.error as Error).message}
              </span>
            )}
            {detected && !detection.isFetching && (
              <span className="mt-1 block text-xs text-black/60">
                Detected from the photo:{' '}
                {detected.categories
                  .slice(0, 2)
                  .map((c) => `${c.label} ${Math.round(c.confidence * 100)}%`)
                  .join(', ')}
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
          <div className="text-sm">
            Photos
            <p className="text-xs text-black/50">Real photos of the product. The first one is the main image.</p>
            <div className="mt-2 grid grid-cols-4 gap-2">
              {photoPreviews.map((url, i) => (
                <div key={url} className="group relative aspect-[3/4] overflow-hidden rounded-lg bg-black/5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt={`Photo ${i + 1}`} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => setPhotos((current) => current.filter((_, j) => j !== i))}
                    className="absolute right-1 top-1 rounded bg-white/90 px-1.5 py-0.5 text-xs text-red-600 opacity-0 group-hover:opacity-100"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <label className="flex aspect-[3/4] cursor-pointer items-center justify-center rounded-lg border border-dashed border-black/30 text-center text-xs text-black/50 hover:bg-black/5">
                + Add photos
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = '';
                    setPhotos((current) => [...current, ...files]);
                  }}
                />
              </label>
            </div>
          </div>
          <button
            type="submit"
            disabled={create.isPending}
            className="rounded-md bg-ink px-6 py-3 text-sm font-medium text-paper disabled:opacity-40"
          >
            {create.isPending ? 'Creating…' : 'Create product'}
          </button>
          {create.isError && (
            <div className="text-xs text-red-600">
              <p>{create.error.message}</p>
              {create.error instanceof ApiError &&
                (create.error.body as { errors?: { path: string; message: string }[] } | null)?.errors?.map(
                  (issue) => (
                    <p key={issue.path}>
                      {issue.path || 'form'}: {issue.message}
                    </p>
                  ),
                )}
            </div>
          )}
        </form>
      ) : (
        <div className="space-y-6">
          <p className="rounded-lg bg-black/5 p-4 text-sm">
            Product created (id: <span className="font-mono">{productId}</span>).
          </p>

          <div className="rounded-lg border border-black/10 p-4 text-sm">
            <p className="mb-2 font-medium">Photos</p>
            <div className="grid grid-cols-4 gap-2">
              {status?.images.map((image, i) => (
                <div key={image.key} className="aspect-[3/4] overflow-hidden rounded-lg bg-black/5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={image.url} alt={`Photo ${i + 1}`} className="h-full w-full object-cover" />
                </div>
              ))}
              <label className="flex aspect-[3/4] cursor-pointer items-center justify-center rounded-lg border border-dashed border-black/30 text-center text-xs text-black/50 hover:bg-black/5">
                {addMorePhotos.isPending ? 'Uploading…' : '+ Add photos'}
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  disabled={addMorePhotos.isPending}
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = '';
                    if (files.length > 0) addMorePhotos.mutate(files);
                  }}
                />
              </label>
            </div>
            {photoError && <p className="mt-2 text-xs text-red-600">Photo upload failed: {photoError}</p>}
          </div>

          <div className="rounded-lg border border-black/10 p-4 text-sm">
            <p>
              Published: <span className="font-medium">{status?.isPublished ? 'yes' : 'no'}</span>
            </p>
            <button
              type="button"
              disabled={status?.isPublished || publish.isPending}
              onClick={() => publish.mutate()}
              className="mt-3 rounded-md bg-ink px-4 py-2 text-xs text-paper disabled:opacity-40"
            >
              Publish
            </button>
          </div>

          <div className="rounded-lg border border-black/10 p-4 text-sm">
            <p className="mb-2 font-medium">3D fitting room garment</p>
            <p className="mb-3 text-xs text-black/60">
              The product type chosen above decides how the avatar wears this: a t-shirt or
              long sleeve goes on over the avatar&apos;s own trousers, shorts go on under its
              own shirt, and a dress replaces both.
            </p>

            <div className="mb-3 flex flex-wrap gap-2 text-xs">
              {(
                [
                  { key: 'MANUAL', label: 'Upload a .glb' },
                  { key: 'LOCAL_BAKE', label: 'Bake from flat-lay photos (free, fast)' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setGarmentProvider(opt.key)}
                  className={`rounded-md border px-3 py-1 ${
                    garmentProvider === opt.key ? 'border-ink bg-ink text-paper' : 'border-black/20'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {garmentProvider === 'MANUAL' && (
              <p className="mb-3 text-xs text-black/50">
                No AI reconstruction runs here: the file is validated and stored as-is, and the
                customer viewer skins it onto the shared avatar with no real cloth simulation.
              </p>
            )}

            {garmentProvider === 'LOCAL_BAKE' && (
              <div className="mb-3">
                <p className="mb-3 text-xs text-black/50">
                  Lay the garment flat and photograph it straight down, once per side. The
                  photos are baked into a texture for the avatar&apos;s own garment mesh, so
                  it drapes and moves correctly, but the silhouette is the avatar&apos;s, not
                  this garment&apos;s: a hoodie and a crop top come out the same shape. Only
                  the print, colour and fabric read as the real item. Takes a few minutes,
                  nearly all of it background removal.
                </p>
                <div className="flex flex-col gap-2 text-xs">
                  <label className="flex items-center gap-2">
                    <span className="w-28 text-black/60">Front photo *</span>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      disabled={generate3D.isPending}
                      onChange={(e) => setBakeFront(e.target.files?.[0] ?? null)}
                    />
                  </label>
                  <label className="flex items-center gap-2">
                    <span className="w-28 text-black/60">Back photo</span>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      disabled={generate3D.isPending}
                      onChange={(e) => setBakeBack(e.target.files?.[0] ?? null)}
                    />
                  </label>
                </div>
                <p className="mt-2 text-xs text-black/40">
                  No side photos: a flat-lay has no true side view, and anything not
                  photographed takes the colour of the fabric next to it.
                </p>
                <button
                  type="button"
                  disabled={!bakeFront || generate3D.isPending}
                  onClick={() =>
                    generate3D.mutate([bakeFront!, ...(bakeBack ? [bakeBack] : [])])
                  }
                  className="mt-3 rounded-md border border-ink bg-ink px-3 py-1 text-xs text-paper disabled:opacity-40"
                >
                  {generate3D.isPending ? 'Baking…' : 'Bake garment texture'}
                </button>
              </div>
            )}

            {garmentProvider === 'MANUAL' && (
              <input
                type="file"
                accept=".glb,model/gltf-binary"
                disabled={generate3D.isPending}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length > 0) generate3D.mutate(files);
                }}
                className="block text-xs"
              />
            )}
            {generate3D.isPending && (
              <p className="mt-2 text-xs text-black/50">
                {garmentProvider === 'MANUAL' ? 'Uploading…' : 'Uploading and queuing generation…'}
              </p>
            )}
            {generate3D.isError && (
              <p className="mt-2 text-xs text-red-600">{(generate3D.error as Error).message}</p>
            )}
            {garmentJob && (
              <p className="mt-2 text-xs">
                Status: <span className="font-medium">{garmentJob.generationStatus}</span>
                {garmentJob.failureReason && (
                  <span className="text-red-600">: {garmentJob.failureReason}</span>
                )}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
