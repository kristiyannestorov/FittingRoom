'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { ProductStatsRow } from '@zed/contracts';
import { analyticsApi } from '@/lib/api/analytics';
import { Spinner, EmptyState } from '@/components/ui/state';

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
] as const;

const CARD_CLICK_COLOR = '#2a78d6';
const PAGE_VIEW_COLOR = '#eb6834';

const CHART_ROWS = 12;

export default function AdminAnalyticsPage() {
  const [days, setDays] = useState<number>(30);

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-product-stats', days],
    queryFn: () => analyticsApi.productStats(days, 100),
  });

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold">Product analytics</h1>
      <p className="mb-6 text-sm text-black/50">
        Card clicks in the catalog and views of the product page, per product.
      </p>

      <div className="mb-6 flex gap-2">
        {RANGES.map((range) => (
          <button
            key={range.days}
            type="button"
            onClick={() => setDays(range.days)}
            className={`rounded-md border px-3 py-1 text-sm ${
              days === range.days ? 'border-ink bg-ink text-paper' : 'border-black/20'
            }`}
          >
            {range.label}
          </button>
        ))}
      </div>

      {isLoading && <Spinner label="Loading analytics…" />}
      {error && <p className="text-red-600">Could not load analytics.</p>}

      {data && data.rows.length === 0 && (
        <EmptyState
          title="No product events recorded yet"
          description="Tracking starts once the API and web app are deployed with this change, and only for visitors who accept cookies. Numbers will appear here as the catalog gets traffic."
        />
      )}

      {data && data.rows.length > 0 && (
        <>
          <div className="mb-8 grid gap-4 sm:grid-cols-3">
            <StatTile label="Card clicks" value={data.totals.cardClicks} sub={`last ${days} days`} />
            <StatTile label="Product page views" value={data.totals.pageViews} sub={`last ${days} days`} />
            <StatTile
              label="Products with traffic"
              value={data.totals.trackedProducts}
              sub="had at least one event"
            />
          </div>

          <RankedBars rows={data.rows.slice(0, CHART_ROWS)} />
          <StatsTable rows={data.rows} />
        </>
      )}
    </div>
  );
}

function RankedBars({ rows }: { rows: ProductStatsRow[] }) {
  const max = Math.max(...rows.map((row) => Math.max(row.cardClicks, row.pageViews)), 1);

  return (
    <section className="mb-10">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-medium">Most clicked products</h2>
        <div className="flex gap-4 text-xs text-black/60">
          <LegendItem color={CARD_CLICK_COLOR} label="Card clicks" />
          <LegendItem color={PAGE_VIEW_COLOR} label="Page views" />
        </div>
      </div>

      <div className="space-y-3 rounded-lg border border-black/10 p-4">
        {rows.map((row) => (
          <div key={row.productId} className="grid grid-cols-[minmax(0,10rem)_1fr] items-center gap-3">
            <Link
              href={`/products/${row.slug}`}
              className="truncate text-sm text-black/70 hover:text-ink hover:underline"
              title={row.name}
            >
              {row.name}
            </Link>
            <div className="flex flex-col gap-[2px]">
              <Bar
                value={row.cardClicks}
                max={max}
                color={CARD_CLICK_COLOR}
                label={`${row.cardClicks} card clicks`}
              />
              <Bar
                value={row.pageViews}
                max={max}
                color={PAGE_VIEW_COLOR}
                label={`${row.pageViews} page views`}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Bar({
  value,
  max,
  color,
  label,
}: {
  value: number;
  max: number;
  color: string;
  label: string;
}) {
  return (
    <div className="group flex h-3 items-center gap-2" title={label}>
      <div
        className="h-3 rounded-r-[4px] transition-[width]"
        style={{ width: `${Math.max((value / max) * 100, value > 0 ? 1 : 0)}%`, background: color }}
      />
      <span className="text-xs tabular-nums text-black/50 opacity-0 transition group-hover:opacity-100">
        {value}
      </span>
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

function StatsTable({ rows }: { rows: ProductStatsRow[] }) {
  return (
    <section>
      <h2 className="mb-3 text-lg font-medium">All products with traffic</h2>
      <div className="overflow-x-auto rounded-lg border border-black/10">
        <table className="w-full text-sm">
          <thead className="border-b border-black/10 text-left text-black/50">
            <tr>
              <th className="px-4 py-2 font-medium">Product</th>
              <th className="px-4 py-2 text-right font-medium">Card clicks</th>
              <th className="px-4 py-2 text-right font-medium">Page views</th>
              <th className="px-4 py-2 text-right font-medium">Unique visitors</th>
              <th className="px-4 py-2 text-right font-medium">Views / click</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.productId} className="border-b border-black/5 last:border-0">
                <td className="px-4 py-2">
                  <Link href={`/products/${row.slug}`} className="hover:underline">
                    {row.name}
                  </Link>
                  {!row.isPublished && (
                    <span className="ml-2 text-xs text-black/40">unpublished</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{row.cardClicks}</td>
                <td className="px-4 py-2 text-right tabular-nums">{row.pageViews}</td>
                <td className="px-4 py-2 text-right tabular-nums">{row.uniqueVisitors}</td>
                <td className="px-4 py-2 text-right tabular-nums text-black/60">
                  {row.clickThroughRate === null ? 'N/A' : `${row.clickThroughRate}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StatTile({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div className="rounded-lg border border-black/10 p-4">
      <p className="text-sm text-black/50">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value.toLocaleString()}</p>
      <p className="mt-1 text-xs text-black/40">{sub}</p>
    </div>
  );
}
