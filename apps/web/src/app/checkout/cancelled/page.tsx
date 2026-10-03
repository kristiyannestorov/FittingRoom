'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

export default function CheckoutCancelledPage() {
  return (
    <Suspense fallback={null}>
      <CheckoutCancelledContent />
    </Suspense>
  );
}

function CheckoutCancelledContent() {
  const orderNumber = useSearchParams().get('order');

  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <h1 className="text-2xl font-semibold">Checkout cancelled</h1>
      <p className="text-black/60">
        {orderNumber ? `Order ${orderNumber} was not paid.` : 'No payment was made.'} Your cart is
        unchanged.
      </p>
      <Link href="/cart" className="mt-4 rounded-md bg-ink px-6 py-3 text-sm text-paper">
        Back to cart
      </Link>
    </div>
  );
}
