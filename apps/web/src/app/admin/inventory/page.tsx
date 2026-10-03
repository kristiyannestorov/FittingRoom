'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminApi } from '@/lib/api/admin';

export default function AdminInventoryPage() {
  const queryClient = useQueryClient();
  const [sku, setSku] = useState('');
  const [delta, setDelta] = useState(0);
  const [reason, setReason] = useState('Restock');

  const { data: lowStock, isLoading } = useQuery({
    queryKey: ['low-stock'],
    queryFn: adminApi.inventory.lowStock,
  });

  const adjust = useMutation({
    mutationFn: () => adminApi.inventory.adjust({ sku, delta, reason }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['low-stock'] }),
  });

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Inventory</h1>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-medium">Low stock</h2>
        {isLoading && <p className="text-black/50">Loading…</p>}
        {lowStock?.length === 0 && <p className="text-black/50">Nothing below its reorder threshold.</p>}
        <div className="space-y-2">
          {lowStock?.map((row) => (
            <div key={row.id} className="flex items-center justify-between rounded-lg border border-black/10 p-3 text-sm">
              <span className="font-mono">{row.sku}</span>
              <span>
                {row.quantityAvailable} available (reorder at {row.reorderThreshold})
              </span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium">Adjust stock</h2>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            adjust.mutate();
          }}
        >
          <label className="text-sm">
            SKU
            <input
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              required
              className="mt-1 block rounded-lg border border-black/20 px-3 py-2"
            />
          </label>
          <label className="text-sm">
            Delta (+/-)
            <input
              type="number"
              value={delta}
              onChange={(e) => setDelta(Number(e.target.value))}
              className="mt-1 block w-28 rounded-lg border border-black/20 px-3 py-2"
            />
          </label>
          <label className="text-sm">
            Reason
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 block rounded-lg border border-black/20 px-3 py-2"
            />
          </label>
          <button
            type="submit"
            disabled={adjust.isPending}
            className="rounded-md bg-ink px-5 py-2 text-sm text-paper disabled:opacity-40"
          >
            Apply
          </button>
        </form>
        {adjust.isSuccess && (
          <p className="mt-2 text-sm text-green-700">
            {adjust.data.sku} is now at {adjust.data.quantityAvailable}.
          </p>
        )}
      </section>
    </div>
  );
}
