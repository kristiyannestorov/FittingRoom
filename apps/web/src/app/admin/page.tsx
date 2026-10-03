'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { Currency } from '@zed/contracts';
import { adminApi } from '@/lib/api/admin';
import { formatDate, formatPriceMinor } from '@/lib/format';

const LINKS = [
  { href: '/admin/orders', label: 'Orders', description: 'View and manually override order status' },
  { href: '/admin/inventory', label: 'Inventory', description: 'Low stock alerts and manual adjustments' },
  { href: '/admin/production', label: 'Production queue', description: 'Made-to-order fulfillment tickets' },
  { href: '/admin/products/new', label: 'Add a product', description: 'Create a new catalog item' },
  { href: '/admin/analytics', label: 'Analytics', description: 'Clicks and page views per product' },
  { href: '/admin/emails', label: 'Emails', description: 'Sent/queued outbound email log' },
];

export default function AdminHomePage() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin-stats'],
    queryFn: () => adminApi.stats.get(),
    refetchInterval: 60_000,
  });

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Dashboard</h1>

      {isLoading && <p className="mb-6 text-black/50">Loading stats…</p>}

      {data && (
        <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Revenue (30d)"
            value={formatPriceMinor(data.revenue.last30DaysMinor, data.revenue.currency)}
            sub={`${formatPriceMinor(data.revenue.allTimeMinor, data.revenue.currency)} all-time`}
          />
          <StatTile
            label="Orders (30d)"
            value={String(data.orders.last30Days)}
            sub={`${data.orders.total} all-time`}
          />
          <StatTile
            label="Low stock items"
            value={String(data.inventory.lowStockCount)}
            sub="reorder threshold reached"
            tone={data.inventory.lowStockCount > 0 ? 'warning' : 'default'}
          />
          <StatTile
            label="In production"
            value={String(data.production.byStatus.IN_PROGRESS ?? 0)}
            sub={`${data.production.byStatus.QUEUED ?? 0} queued`}
          />
        </div>
      )}

      <div className="mb-8 grid gap-4 sm:grid-cols-2">
        {LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="rounded-lg border border-black/10 p-5 hover:bg-black/5"
          >
            <p className="font-medium">{link.label}</p>
            <p className="mt-1 text-sm text-black/50">{link.description}</p>
          </Link>
        ))}
      </div>

      {data && data.recentOrders.length > 0 && (
        <div>
          <h2 className="mb-3 text-lg font-medium">Recent orders</h2>
          <div className="space-y-2">
            {data.recentOrders.map((order) => (
              <div
                key={order.id}
                className="flex items-center justify-between rounded-lg border border-black/10 p-3 text-sm"
              >
                <div>
                  <p className="font-medium">{order.orderNumber}</p>
                  <p className="text-black/50">{formatDate(order.createdAt)}</p>
                </div>
                <div className="text-right">
                  <p className="font-medium">
                    {formatPriceMinor(order.totalMinor, order.currency as Currency)}
                  </p>
                  <p className="text-black/50">{order.status}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatTile({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'default' | 'warning';
}) {
  return (
    <div className="rounded-lg border border-black/10 p-4">
      <p className="text-sm text-black/50">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tone === 'warning' ? 'text-red-600' : ''}`}>
        {value}
      </p>
      <p className="mt-1 text-xs text-black/40">{sub}</p>
    </div>
  );
}
