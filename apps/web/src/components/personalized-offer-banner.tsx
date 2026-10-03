'use client';

import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { DiscountView, ProductType } from '@zed/contracts';
import { discountsApi } from '@/lib/api/discounts';
import {
  VIEW_THRESHOLD,
  hasClaimedOffer,
  hasCookieConsent,
  markOfferClaimed,
} from '@/lib/view-tracking';

const LABELS: Record<ProductType, string> = {
  DRESS: 'dresses',
  T_SHIRT: 't-shirts',
  SHORTS: 'shorts',
  PANTS: 'pants',
  LONG_SLEEVE: 'long sleeves',
  HOODIE: 'hoodies',
};

export function PersonalizedOfferBanner({
  productType,
  viewCount,
}: {
  productType: ProductType;
  viewCount: number;
}) {
  const [offer, setOffer] = useState<DiscountView | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const claim = useMutation({
    mutationFn: () => discountsApi.claim(productType),
    onSuccess: (discount) => {
      markOfferClaimed(productType);
      setOffer(discount);
    },
  });

  useEffect(() => {
    if (
      hasCookieConsent() &&
      viewCount >= VIEW_THRESHOLD &&
      !hasClaimedOffer(productType) &&
      claim.status === 'idle'
    ) {
      claim.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productType, viewCount]);

  if (!offer || dismissed) return null;

  return (
    <div className="mb-6 flex items-center justify-between rounded-lg border border-accent/30 bg-accent/10 p-4">
      <div>
        <p className="font-medium">
          {offer.percentOff}% off {LABELS[productType]}, just for you
        </p>
        <p className="mt-1 text-sm text-black/60">
          Use code <span className="font-mono font-semibold">{offer.code}</span> at checkout.
          Expires {new Date(offer.expiresAt).toLocaleDateString()}.
        </p>
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="ml-4 shrink-0 text-sm text-black/50 hover:text-ink"
      >
        Dismiss
      </button>
    </div>
  );
}
