'use client';

import { Suspense, useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PRODUCT_TYPES, type Gender, type ProductType } from '@zed/contracts';
import { productsApi } from '@/lib/api/products';
import { ProductCard } from '@/components/product-card';
import { Spinner, EmptyState } from '@/components/ui/state';

const TYPE_LABEL: Record<ProductType, string> = {
  DRESS: 'Dresses',
  T_SHIRT: 'T-Shirts',
  SHORTS: 'Shorts',
  PANTS: 'Pants',
  LONG_SLEEVE: 'Long Sleeves',
  HOODIE: 'Hoodies',
};

const GENDER_LABEL: Record<Gender, string> = { FEMALE: 'Women', MALE: 'Men' };

const PER_PAGE = 24;

export default function ProductsPage() {
  return (
    <Suspense fallback={<Spinner label="Loading catalog…" />}>
      <ProductsPageContent />
    </Suspense>
  );
}

function ProductsPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const productType = PRODUCT_TYPES.find((t) => t === searchParams.get('type'));
  const gender = (['FEMALE', 'MALE'] as const).find((g) => g === searchParams.get('gender'));
  const page = Math.max(Number(searchParams.get('page')) || 1, 1);

  const { data, isLoading, isPlaceholderData, error } = useQuery({
    queryKey: ['products', productType, gender, page],
    queryFn: () => productsApi.list({ perPage: PER_PAGE, page, productType, gender }),
    placeholderData: keepPreviousData,
  });

  const totalPages = data?.totalPages ?? 1;

  function navigate(next: { type?: ProductType; gender?: Gender; page?: number }) {
    const params = new URLSearchParams();
    const type = 'type' in next ? next.type : productType;
    const who = 'gender' in next ? next.gender : gender;
    const target = next.page ?? 1;

    if (type) params.set('type', type);
    if (who) params.set('gender', who);
    if (target > 1) params.set('page', String(target));

    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [page]);

  useEffect(() => {
    if (data && page > data.totalPages && data.totalPages > 0) {
      navigate({ page: data.totalPages });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, page]);

  if (error) {
    return <p className="text-red-600">Could not load the catalog. Is the API running?</p>;
  }

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Catalog</h1>

      <div className="mb-6 flex flex-wrap items-center gap-4">
        <div className="flex flex-wrap gap-2">
          <FilterButton active={!productType} onClick={() => navigate({ type: undefined })}>
            All
          </FilterButton>
          {PRODUCT_TYPES.map((t) => (
            <FilterButton key={t} active={productType === t} onClick={() => navigate({ type: t })}>
              {TYPE_LABEL[t]}
            </FilterButton>
          ))}
        </div>

        <div className="flex gap-2 border-l border-black/10 pl-4">
          <FilterButton active={!gender} onClick={() => navigate({ gender: undefined })}>
            All
          </FilterButton>
          {(['FEMALE', 'MALE'] as const).map((g) => (
            <FilterButton key={g} active={gender === g} onClick={() => navigate({ gender: g })}>
              {GENDER_LABEL[g]}
            </FilterButton>
          ))}
        </div>
      </div>

      {isLoading && <Spinner label="Loading catalog…" />}

      {data && data.items.length === 0 && (
        <EmptyState
          title="No products published yet"
          description="If you are running this locally, seed the catalog with npm run db:seed -w @zed/api."
        />
      )}

      {data && data.items.length > 0 && (
        <>
          <p className="mb-4 text-sm text-black/50">
            {data.total.toLocaleString()} {data.total === 1 ? 'product' : 'products'}
            {totalPages > 1 && ` · page ${data.page} of ${totalPages}`}
          </p>

          <div
            className={`grid grid-cols-2 gap-6 transition-opacity sm:grid-cols-3 lg:grid-cols-4 ${
              isPlaceholderData ? 'opacity-50' : ''
            }`}
          >
            {data.items.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>

          <Pager page={data.page} totalPages={totalPages} onGo={(p) => navigate({ page: p })} />
        </>
      )}
    </div>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-3 py-1 text-sm ${
        active ? 'border-ink bg-ink text-paper' : 'border-black/20'
      }`}
    >
      {children}
    </button>
  );
}

function pageWindow(page: number, totalPages: number): (number | 'gap')[] {
  const span = 1;
  const wanted = new Set<number>([1, totalPages]);
  for (let p = page - span; p <= page + span; p += 1) {
    if (p >= 1 && p <= totalPages) wanted.add(p);
  }

  const out: (number | 'gap')[] = [];
  let previous = 0;
  for (const p of [...wanted].sort((a, b) => a - b)) {
    if (previous && p - previous > 1) out.push('gap');
    out.push(p);
    previous = p;
  }
  return out;
}

function Pager({
  page,
  totalPages,
  onGo,
}: {
  page: number;
  totalPages: number;
  onGo: (page: number) => void;
}) {
  if (totalPages <= 1) return null;

  return (
    <nav aria-label="Catalog pages" className="mt-8 flex items-center justify-center gap-2 text-sm">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onGo(page - 1)}
        className="rounded-md border border-black/20 px-3 py-1 disabled:opacity-40"
      >
        Prev
      </button>

      {pageWindow(page, totalPages).map((entry, index) =>
        entry === 'gap' ? (
          <span key={`gap-${index}`} className="px-1 text-black/30" aria-hidden>
            …
          </span>
        ) : (
          <button
            key={entry}
            type="button"
            onClick={() => onGo(entry)}
            aria-current={entry === page ? 'page' : undefined}
            className={`min-w-[2rem] rounded-md border px-2 py-1 tabular-nums ${
              entry === page ? 'border-ink bg-ink text-paper' : 'border-black/20'
            }`}
          >
            {entry}
          </button>
        ),
      )}

      <button
        type="button"
        disabled={page >= totalPages}
        onClick={() => onGo(page + 1)}
        className="rounded-md border border-black/20 px-3 py-1 disabled:opacity-40"
      >
        Next
      </button>
    </nav>
  );
}
