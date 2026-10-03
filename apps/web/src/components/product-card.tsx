'use client';

import Link from 'next/link';
import Image from 'next/image';
import { formatPriceMinor } from '@/lib/format';
import { analyticsApi } from '@/lib/api/analytics';
import type { ProductListItemView } from '@zed/contracts';

const TYPE_LABEL: Record<string, string> = {
  DRESS: 'Dresses',
  T_SHIRT: 'T-Shirts',
  SHORTS: 'Shorts',
  PANTS: 'Pants',
  LONG_SLEEVE: 'Long Sleeves',
  HOODIE: 'Hoodies',
};

export function ProductCard({ product }: { product: ProductListItemView }) {
  return (
    <Link
      href={`/products/${product.slug}`}
      onClick={() => analyticsApi.trackProductEvent(product.id, 'CARD_CLICK')}
      className="group flex flex-col gap-2"
    >
      <div className="relative aspect-[3/4] overflow-hidden rounded-xl bg-black/5">
        {product.thumbnailUrl ? (
          <Image
            src={product.thumbnailUrl}
            alt={product.name}
            fill
            sizes="(min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw"
            className="object-cover transition duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-black/40">
            No preview
          </div>
        )}
      </div>
      <div className="text-sm">
        <p className="font-medium text-ink">{product.name}</p>
        <p className="text-black/50">{formatPriceMinor(product.basePriceMinor, product.currency)}</p>
        <p className="text-xs text-black/40">
          {TYPE_LABEL[product.productType] ?? product.productType} · {product.availableSizes.join(', ')}
        </p>
      </div>
    </Link>
  );
}
