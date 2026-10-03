'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { paymentsApi } from '@/lib/api/payments';

export default function CheckoutSuccessPage() {
  return (
    <Suspense fallback={null}>
      <CheckoutSuccessContent />
    </Suspense>
  );
}

function CheckoutSuccessContent() {
  const params = useSearchParams();
  const orderNumber = params.get('order');
  const [attempts, setAttempts] = useState(0);

  const { data } = useQuery({
    queryKey: ['reconcile', orderNumber, attempts],
    queryFn: () => paymentsApi.reconcile(orderNumber!),
    enabled: Boolean(orderNumber) && attempts < 8,
  });

  useEffect(() => {
    if (data?.status === 'PAID') return;
    if (attempts >= 8) return;
    const timer = setTimeout(() => setAttempts((n) => n + 1), 1500);
    return () => clearTimeout(timer);
  }, [data, attempts]);

  const confirmed = data?.status === 'PAID';

  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <h1 className="text-2xl font-semibold">
        {confirmed ? 'Payment confirmed' : 'Confirming payment…'}
      </h1>
      <p className="text-black/60">Order {orderNumber}</p>
      {!confirmed && attempts >= 8 && (
        <p className="max-w-sm text-sm text-amber-700">
          Still waiting on confirmation from your payment provider. This can take a minute --
          check your orders page shortly.
        </p>
      )}
      <Link href="/orders" className="mt-4 rounded-md bg-ink px-6 py-3 text-sm text-paper">
        View your orders
      </Link>
    </div>
  );
}
