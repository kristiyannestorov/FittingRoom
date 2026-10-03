'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { PRODUCT_TYPES, type ProductType } from '@zed/contracts';
import { productsApi } from '@/lib/api/products';
import { ProductCard } from '@/components/product-card';
import { Spinner } from '@/components/ui/state';

const TYPE_LABEL: Record<ProductType, string> = {
  DRESS: 'Dresses',
  T_SHIRT: 'T-Shirts',
  SHORTS: 'Shorts',
  PANTS: 'Pants',
  LONG_SLEEVE: 'Long Sleeves',
  HOODIE: 'Hoodies',
};

export default function HomePage() {
  const { data, isLoading } = useQuery({
    queryKey: ['products', 'featured'],
    queryFn: () => productsApi.list({ perPage: 8 }),
  });

  return (
    <div className="flex flex-col gap-20">
      <section className="flex flex-col items-center gap-6 py-16 text-center">
        <span className="text-xs font-medium uppercase tracking-[0.2em] text-accent">
          New season, made to fit
        </span>
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
          Clothing shaped around you, not the other way around
        </h1>
        <p className="max-w-xl text-black/60">
          Browse the catalog, try garments on in the 3D fitting room, and order pieces made or
          picked to your size.
        </p>
        <div className="flex gap-4">
          <Link
            href="/products"
            className="rounded-md bg-ink px-6 py-3 text-sm font-medium text-paper hover:bg-ink/90"
          >
            Browse the catalog
          </Link>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-medium">Shop by category</h2>
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {PRODUCT_TYPES.map((type) => (
            <Link
              key={type}
              href={`/products?type=${type}`}
              className="rounded-xl border border-black/10 p-6 text-center font-medium hover:bg-black/5"
            >
              {TYPE_LABEL[type]}
            </Link>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Fresh in</h2>
          <Link href="/products" className="text-sm text-accent hover:underline">
            View all
          </Link>
        </div>
        {isLoading && <Spinner label="Loading products…" />}
        {data && data.items.length > 0 && (
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4">
            {data.items.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
