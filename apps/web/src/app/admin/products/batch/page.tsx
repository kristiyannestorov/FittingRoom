'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  CLOTHING_SIZES,
  MAX_BATCH_PRODUCTS,
  PRODUCT_TYPES,
  PRODUCT_TYPE_CATEGORIES,
  type BatchProductResult,
  type BatchProductStatus,
  type ClothingSize,
  type Gender,
  type ProductCategory,
  type ProductType,
} from '@zed/contracts';
import { adminApi } from '@/lib/api/admin';
import { ApiError } from '@/lib/api-client';

interface Row {
  id: number;
  name: string;
  slug: string;
  slugEdited: boolean;
  description: string;
  priceMajor: string;
  productType: ProductType;
  category: ProductCategory;
  categoryEdited: boolean;
  gender: Gender;
  colorName: string;
  colorHex: string;
  sizes: ClothingSize[];
  stock: string;
  front: File | null;
  back: File | null;
}

let nextId = 1;

function blankRow(from?: Row): Row {
  return {
    id: nextId++,
    name: '',
    slug: '',
    slugEdited: false,
    description: '',
    priceMajor: from?.priceMajor ?? '29.00',
    productType: from?.productType ?? 'T_SHIRT',
    category: from?.category ?? PRODUCT_TYPE_CATEGORIES.T_SHIRT[0],
    categoryEdited: false,
    gender: from?.gender ?? 'MALE',
    colorName: '',
    colorHex: '#111111',
    sizes: from?.sizes ?? ['XS', 'S', 'M', 'L', 'XL'],
    stock: from?.stock ?? '10',
    front: null,
    back: null,
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const inputClass = 'mt-1 w-full rounded-lg border border-black/20 px-2 py-1.5 text-sm';

export default function BatchProductsPage() {
  const [rows, setRows] = useState<Row[]>(() => [blankRow()]);
  const [schedule, setSchedule] = useState<'now' | 'later'>('now');
  const [runAtLocal, setRunAtLocal] = useState('');
  const [submitted, setSubmitted] = useState<{ runAt: string; results: BatchProductResult[] } | null>(null);

  const update = (id: number, patch: Partial<Row>) =>
    setRows((current) => current.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const submit = useMutation({
    mutationFn: () =>
      adminApi.products.batchCreate(
        rows.map((r) => ({
          item: {
            name: r.name.trim(),
            slug: r.slug,
            description: r.description,
            productType: r.productType,
            category: r.category,
            gender: r.gender,
            basePriceMinor: Math.round(Number(r.priceMajor) * 100),
            currency: 'EUR',
            availableSizes: r.sizes,
            fulfillmentType: 'STOCKED',
            materials: [],
            weightGrams: r.productType === 'HOODIE' ? 600 : 300,
            colorName: r.colorName.trim() || 'Default',
            colorHex: r.colorHex,
            stock: Math.max(0, Math.round(Number(r.stock) || 0)),
          },
          front: r.front!,
          back: r.back,
        })),
        schedule === 'later' && runAtLocal ? new Date(runAtLocal).toISOString() : null,
      ),
    onSuccess: setSubmitted,
  });

  const missing = rows.flatMap((r, i) => [
    ...(r.name.trim() ? [] : [`row ${i + 1}: name`]),
    ...(r.slug ? [] : [`row ${i + 1}: slug`]),
    ...(Number(r.priceMajor) > 0 ? [] : [`row ${i + 1}: price`]),
    ...(r.sizes.length ? [] : [`row ${i + 1}: sizes`]),
    ...(r.front ? [] : [`row ${i + 1}: front photo`]),
  ]);
  const scheduleMissing = schedule === 'later' && !runAtLocal;

  if (submitted) return <BatchProgress submitted={submitted} onReset={() => { setSubmitted(null); setRows([blankRow()]); }} />;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-2 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Batch create products</h1>
        <Link href="/admin/products" className="text-sm underline">
          Back to products
        </Link>
      </div>
      <p className="mb-6 text-sm text-black/60">
        One card per product, up to {MAX_BATCH_PRODUCTS}. Each needs a flat-lay front photo (a back photo makes the back
        of the garment real instead of guessed). Products are created hidden, their 3D garments bake one at a time from
        the time you choose (about 3 minutes each), and each one goes live on its own as soon as its 3D is ready.
      </p>

      <div className="flex flex-col gap-4">
        {rows.map((row, i) => (
          <BatchRow
            key={row.id}
            index={i}
            row={row}
            onChange={(patch) => update(row.id, patch)}
            onRemove={rows.length > 1 ? () => setRows((c) => c.filter((r) => r.id !== row.id)) : undefined}
            onDuplicate={
              rows.length < MAX_BATCH_PRODUCTS
                ? () => setRows((c) => [...c.slice(0, i + 1), blankRow(row), ...c.slice(i + 1)])
                : undefined
            }
          />
        ))}
      </div>

      <button
        type="button"
        disabled={rows.length >= MAX_BATCH_PRODUCTS}
        onClick={() => setRows((c) => [...c, blankRow(c[c.length - 1])])}
        className="mt-4 rounded-md border border-dashed border-black/30 px-4 py-2 text-sm hover:bg-black/5 disabled:opacity-40"
      >
        + Add product
      </button>

      <div className="mt-8 rounded-lg border border-black/10 p-4 text-sm">
        <p className="mb-2 font-medium">When should the 3D generate?</p>
        <label className="mr-6 inline-flex items-center gap-2">
          <input type="radio" checked={schedule === 'now'} onChange={() => setSchedule('now')} />
          Start now
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="radio" checked={schedule === 'later'} onChange={() => setSchedule('later')} />
          Schedule for
        </label>
        {schedule === 'later' && (
          <input
            type="datetime-local"
            value={runAtLocal}
            min={new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)}
            onChange={(e) => setRunAtLocal(e.target.value)}
            className="ml-3 rounded-lg border border-black/20 px-2 py-1"
          />
        )}
        <p className="mt-2 text-xs text-black/50">
          Scheduling overnight keeps the machine free while you work: the photos upload now, the baking waits.
        </p>
      </div>

      <div className="mt-6 flex items-center gap-4">
        <button
          type="button"
          disabled={missing.length > 0 || scheduleMissing || submit.isPending}
          onClick={() => submit.mutate()}
          className="rounded-md bg-ink px-6 py-3 text-sm font-medium text-paper disabled:opacity-40"
        >
          {submit.isPending
            ? 'Uploading…'
            : `Create ${rows.length} product${rows.length === 1 ? '' : 's'}${schedule === 'later' ? ' and schedule' : ''}`}
        </button>
        {(missing.length > 0 || scheduleMissing) && (
          <p className="text-xs text-black/50">
            Still needed: {[...missing, ...(scheduleMissing ? ['a date and time'] : [])].slice(0, 4).join(', ')}
            {missing.length > 4 ? ` and ${missing.length - 4} more` : ''}
          </p>
        )}
      </div>
      {submit.isError && (
        <div className="mt-3 text-xs text-red-600">
          <p>{submit.error.message}</p>
          {submit.error instanceof ApiError &&
            ((submit.error.body as { errors?: string[] } | null)?.errors ?? []).map((e) => <p key={e}>{e}</p>)}
        </div>
      )}
    </div>
  );
}

function BatchRow({
  index,
  row,
  onChange,
  onRemove,
  onDuplicate,
}: {
  index: number;
  row: Row;
  onChange: (patch: Partial<Row>) => void;
  onRemove?: () => void;
  onDuplicate?: () => void;
}) {
  const frontPreview = useMemo(() => (row.front ? URL.createObjectURL(row.front) : null), [row.front]);
  const backPreview = useMemo(() => (row.back ? URL.createObjectURL(row.back) : null), [row.back]);
  useEffect(() => () => void (frontPreview && URL.revokeObjectURL(frontPreview)), [frontPreview]);
  useEffect(() => () => void (backPreview && URL.revokeObjectURL(backPreview)), [backPreview]);

  const detection = useQuery({
    queryKey: ['classify-garment', row.front && `${row.front.name}:${row.front.size}:${row.front.lastModified}`, row.productType],
    queryFn: () => adminApi.garmentGeneration.classify([row.front!], row.productType),
    enabled: Boolean(row.front),
    staleTime: Infinity,
    retry: false,
  });
  const best = detection.data?.categories[0];
  useEffect(() => {
    if (
      !row.categoryEdited &&
      detection.data?.productType === row.productType &&
      best &&
      PRODUCT_TYPE_CATEGORIES[row.productType].includes(best.label)
    ) {
      onChange({ category: best.label });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detection.data, row.productType, row.categoryEdited]);
  const detectedType = detection.data?.productTypes[0];

  const toggleSize = (size: ClothingSize) =>
    onChange({ sizes: row.sizes.includes(size) ? row.sizes.filter((s) => s !== size) : [...row.sizes, size] });

  return (
    <div className="grid grid-cols-[180px_1fr] gap-4 rounded-lg border border-black/10 p-4">
      <div className="flex flex-col gap-2">
        <PhotoPicker label="Front *" file={row.front} preview={frontPreview} onPick={(front) => onChange({ front })} />
        <PhotoPicker label="Back" file={row.back} preview={backPreview} onPick={(back) => onChange({ back })} />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-black/50">Product {index + 1}</span>
          <span className="flex gap-3 text-xs">
            {onDuplicate && (
              <button type="button" onClick={onDuplicate} className="underline">
                Duplicate settings below
              </button>
            )}
            {onRemove && (
              <button type="button" onClick={onRemove} className="text-red-600 underline">
                Remove
              </button>
            )}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <label className="col-span-2 text-sm">
            Name
            <input
              value={row.name}
              onChange={(e) =>
                onChange({ name: e.target.value, ...(row.slugEdited ? {} : { slug: slugify(e.target.value) }) })
              }
              className={inputClass}
            />
          </label>
          <label className="col-span-2 text-sm">
            Slug
            <input
              value={row.slug}
              pattern="[a-z0-9\-]+"
              onChange={(e) => onChange({ slug: slugify(e.target.value), slugEdited: true })}
              className={`${inputClass} font-mono`}
            />
          </label>

          <label className="text-sm">
            Price (EUR)
            <input
              type="number"
              step="0.01"
              min="0"
              value={row.priceMajor}
              onChange={(e) => onChange({ priceMajor: e.target.value })}
              className={inputClass}
            />
          </label>
          <label className="text-sm">
            Type
            <select
              value={row.productType}
              onChange={(e) => {
                const productType = e.target.value as ProductType;
                onChange({ productType, category: PRODUCT_TYPE_CATEGORIES[productType][0], categoryEdited: false });
              }}
              className={inputClass}
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
              value={row.category}
              onChange={(e) => onChange({ category: e.target.value as ProductCategory, categoryEdited: true })}
              className={inputClass}
            >
              {PRODUCT_TYPE_CATEGORIES[row.productType].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Gender
            <select
              value={row.gender}
              onChange={(e) => onChange({ gender: e.target.value as Gender })}
              className={inputClass}
            >
              <option value="MALE">Male</option>
              <option value="FEMALE">Female</option>
            </select>
          </label>

          <label className="text-sm">
            Colour name
            <input
              value={row.colorName}
              placeholder="e.g. Red"
              onChange={(e) => onChange({ colorName: e.target.value })}
              className={inputClass}
            />
          </label>
          <label className="text-sm">
            Colour
            <input
              type="color"
              value={row.colorHex}
              onChange={(e) => onChange({ colorHex: e.target.value })}
              className="mt-1 h-[34px] w-full rounded-lg border border-black/20"
            />
          </label>
          <label className="text-sm">
            Stock per size
            <input
              type="number"
              min="0"
              value={row.stock}
              onChange={(e) => onChange({ stock: e.target.value })}
              className={inputClass}
            />
          </label>
          <div className="text-sm">
            Sizes
            <div className="mt-1 flex flex-wrap gap-1">
              {CLOTHING_SIZES.map((s) => (
                <button
                  type="button"
                  key={s}
                  onClick={() => toggleSize(s)}
                  className={`rounded border px-1.5 py-0.5 text-xs ${
                    row.sizes.includes(s) ? 'border-ink bg-ink text-paper' : 'border-black/20'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <label className="col-span-2 text-sm md:col-span-4">
            Description
            <input
              value={row.description}
              onChange={(e) => onChange({ description: e.target.value })}
              className={inputClass}
            />
          </label>
        </div>

        <div className="mt-2 text-xs">
          {row.front && detection.isFetching && <span className="text-black/50">Detecting category from the front photo…</span>}
          {best && !detection.isFetching && (
            <span className="text-black/60">
              Detected: {detection.data!.categories.slice(0, 2).map((c) => `${c.label} ${Math.round(c.confidence * 100)}%`).join(', ')}
            </span>
          )}
          {detectedType && detectedType.label !== row.productType && detectedType.confidence >= 0.6 && (
            <span className="ml-2 text-amber-700">
              Looks like a {detectedType.label}, not a {row.productType}.{' '}
              <button
                type="button"
                className="underline"
                onClick={() =>
                  onChange({
                    productType: detectedType.label,
                    category: PRODUCT_TYPE_CATEGORIES[detectedType.label][0],
                    categoryEdited: false,
                  })
                }
              >
                Switch
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function PhotoPicker({
  label,
  file,
  preview,
  onPick,
}: {
  label: string;
  file: File | null;
  preview: string | null;
  onPick: (file: File | null) => void;
}) {
  return (
    <label className="relative flex aspect-[4/5] cursor-pointer flex-col items-center justify-center overflow-hidden rounded-lg border border-dashed border-black/30 text-xs text-black/50 hover:bg-black/5">
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt={label} className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <span>+ {label} photo</span>
      )}
      {file && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            onPick(null);
          }}
          className="absolute right-1 top-1 rounded bg-white/90 px-1.5 py-0.5 text-red-600"
        >
          ✕
        </button>
      )}
      <span className="absolute bottom-1 left-1 rounded bg-white/90 px-1.5 py-0.5 text-black/70">{label}</span>
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(e) => {
          onPick(e.target.files?.[0] ?? null);
          e.target.value = '';
        }}
      />
    </label>
  );
}

function statusLabel(status: BatchProductStatus | undefined, runAt: Date): { text: string; tone: string } {
  if (!status) return { text: 'Loading…', tone: 'text-black/50' };
  if (status.isPublished && status.generationStatus === 'COMPLETED') return { text: 'Live in the store', tone: 'text-green-700' };
  switch (status.generationStatus) {
    case 'FAILED':
      return { text: `3D failed, kept hidden: ${status.failureReason ?? 'unknown error'}`, tone: 'text-red-600' };
    case 'PROCESSING':
      return { text: 'Baking 3D…', tone: 'text-amber-700' };
    case 'COMPLETED':
      return { text: '3D ready (hidden)', tone: 'text-black/70' };
    default:
      return runAt.getTime() > Date.now()
        ? { text: `Scheduled for ${runAt.toLocaleString()}`, tone: 'text-black/60' }
        : { text: 'Waiting its turn to bake', tone: 'text-black/60' };
  }
}

function BatchProgress({
  submitted,
  onReset,
}: {
  submitted: { runAt: string; results: BatchProductResult[] };
  onReset: () => void;
}) {
  const runAt = new Date(submitted.runAt);
  const ids = submitted.results.flatMap((r) => (r.productId ? [r.productId] : []));
  const { data } = useQuery({
    queryKey: ['batch-status', ids],
    queryFn: () => adminApi.products.batchStatus(ids),
    enabled: ids.length > 0,
    refetchInterval: (query) =>
      query.state.data?.some((s) => s.generationStatus === 'PENDING' || s.generationStatus === 'PROCESSING')
        ? 5000
        : false,
  });
  const byId = new Map((data ?? []).map((s) => [s.productId, s]));
  const live = (data ?? []).filter((s) => s.isPublished).length;

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-2 text-2xl font-semibold">Batch submitted</h1>
      <p className="mb-6 text-sm text-black/60">
        {runAt.getTime() > Date.now() ? `3D starts ${runAt.toLocaleString()}` : '3D generation has started'}. {live} of{' '}
        {ids.length} live. You can leave this page; products publish themselves as their 3D finishes, and this list is
        also on the products page under their slugs.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-black/10 text-left text-xs text-black/50">
            <th className="py-2">#</th>
            <th>Product</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {submitted.results.map((r) => {
            const status = r.productId ? byId.get(r.productId) : undefined;
            const label = r.error ? { text: `Not created: ${r.error}`, tone: 'text-red-600' } : statusLabel(status, runAt);
            return (
              <tr key={r.row} className="border-b border-black/5">
                <td className="py-2 pr-3 text-black/40">{r.row + 1}</td>
                <td className="pr-3">
                  {r.productId ? (
                    <Link href={`/admin/products/${r.productId}/edit`} className="underline">
                      {status?.name ?? r.slug}
                    </Link>
                  ) : (
                    r.slug
                  )}
                </td>
                <td className={label.tone}>{label.text}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button type="button" onClick={onReset} className="mt-6 rounded-md border border-black/20 px-4 py-2 text-sm">
        Start another batch
      </button>
    </div>
  );
}
