'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ordersApi } from '@/lib/api/orders';
import { useAuthStore } from '@/store/auth-store';
import { formatDate, formatPriceMinor } from '@/lib/format';
import { Spinner, EmptyState } from '@/components/ui/state';

const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: 'Awaiting payment',
  PAID: 'Paid',
  IN_PRODUCTION: 'In production',
  PACKED: 'Packed',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
  PAYMENT_FAILED: 'Payment failed',
};

export default function OrdersPage() {
  const tokens = useAuthStore((s) => s.tokens);
  const { data: orders, isLoading } = useQuery({
    queryKey: ['orders'],
    queryFn: ordersApi.list,
    enabled: Boolean(tokens),
  });

  if (!tokens) {
    return (
      <div className="py-16 text-center">
        <p className="mb-4">Sign in to see your orders.</p>
        <Link href="/login" className="rounded-md bg-ink px-6 py-3 text-sm text-paper">
          Sign in
        </Link>
      </div>
    );
  }

  if (isLoading) return <Spinner label="Loading orders…" />;
  if (!orders || orders.length === 0) return <EmptyState title="No orders yet" />;

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Your orders</h1>
      <div className="space-y-3">
        {orders.map((order) => (
          <Link
            key={order.id}
            href={`/orders/${order.id}`}
            className="flex items-center justify-between rounded-lg border border-black/10 p-4 hover:bg-black/5"
          >
            <div>
              <p className="font-medium">{order.orderNumber}</p>
              <p className="text-sm text-black/50">{formatDate(order.createdAt)}</p>
            </div>
            <div className="text-right">
              <p className="text-sm">{STATUS_LABEL[order.status] ?? order.status}</p>
              <p className="font-medium">{formatPriceMinor(order.totalMinor, order.currency)}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
