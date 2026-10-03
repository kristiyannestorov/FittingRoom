'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrderStatus } from '@zed/contracts';
import { adminApi } from '@/lib/api/admin';
import { formatDate, formatPriceMinor } from '@/lib/format';

const STATUSES: OrderStatus[] = [
  'PENDING_PAYMENT',
  'PAID',
  'IN_PRODUCTION',
  'PACKED',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'REFUNDED',
  'PAYMENT_FAILED',
];

export default function AdminOrdersPage() {
  const [statusFilter, setStatusFilter] = useState<OrderStatus | ''>('');
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['admin-orders', statusFilter],
    queryFn: () => adminApi.orders.list(statusFilter || undefined),
  });

  const setStatus = useMutation({
    mutationFn: ({ orderId, status }: { orderId: string; status: OrderStatus }) =>
      adminApi.orders.setStatus(orderId, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-orders'] }),
  });

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Orders</h1>

      <select
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value as OrderStatus | '')}
        className="mb-6 rounded-lg border border-black/20 px-3 py-2 text-sm"
      >
        <option value="">All statuses</option>
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      {isLoading && <p className="text-black/50">Loading…</p>}

      <div className="space-y-3">
        {data?.items.map((order) => (
          <div key={order.id} className="rounded-lg border border-black/10 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{order.orderNumber}</p>
                <p className="text-sm text-black/50">{formatDate(order.createdAt)}</p>
              </div>
              <p className="font-medium">{formatPriceMinor(order.totalMinor, order.currency)}</p>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <span className="text-sm text-black/60">{order.status}</span>
              <select
                defaultValue=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  setStatus.mutate({ orderId: order.id, status: e.target.value as OrderStatus });
                  e.target.value = '';
                }}
                className="rounded-lg border border-black/20 px-2 py-1 text-xs"
              >
                <option value="">Change status…</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
