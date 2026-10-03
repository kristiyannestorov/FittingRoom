'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminApi } from '@/lib/api/admin';
import { ApiError } from '@/lib/api-client';
import { formatPriceMinor } from '@/lib/format';
import { Spinner, EmptyState } from '@/components/ui/state';

export default function AdminProductsPage() {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['admin-products', search, page],
    queryFn: () => adminApi.products.list({ search: search || undefined, page }),
  });

  const togglePublish = useMutation({
    mutationFn: ({ id, published }: { id: string; published: boolean }) =>
      adminApi.products.publish(id, published),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-products'] }),
  });

  const deleteProduct = useMutation({
    mutationFn: (id: string) => adminApi.products.remove(id),
    onSuccess: () => {
      setConfirmingId(null);
      setDeleteError(null);
      queryClient.invalidateQueries({ queryKey: ['admin-products'] });
    },
    onError: (error: unknown) => {
      setConfirmingId(null);
      setDeleteError(error instanceof ApiError ? error.message : 'Failed to delete product');
    },
  });

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Products</h1>
        <div className="flex gap-2">
          <Link
            href="/admin/products/batch"
            className="rounded-md border border-ink px-4 py-2 text-sm font-medium"
          >
            Batch create
          </Link>
          <Link
            href="/admin/products/new"
            className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper"
          >
            Add product
          </Link>
        </div>
      </div>

      <input
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(1);
        }}
        placeholder="Search by name…"
        className="mb-4 w-full max-w-sm rounded-lg border border-black/20 px-3 py-2 text-sm"
      />

      {deleteError && (
        <p className="mb-4 rounded-md border border-red-600/30 bg-red-600/5 px-3 py-2 text-sm text-red-700">
          {deleteError}
        </p>
      )}

      {isLoading && <Spinner label="Loading products…" />}

      {!isLoading && data?.items.length === 0 && (
        <EmptyState title="No products found" description="Try a different search, or add a new product." />
      )}

      {!isLoading && data && data.items.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-black/10">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-black/10 bg-black/5 text-xs uppercase text-black/50">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Price</th>
                <th className="px-4 py-3 font-medium">Visibility</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {data.items.map((product) => (
                <tr key={product.id} className="border-b border-black/5 last:border-0">
                  <td className="px-4 py-3">
                    <Link href={`/admin/products/${product.id}/edit`} className="font-medium hover:underline">
                      {product.name}
                    </Link>
                    <p className="text-xs text-black/40">{product.slug}</p>
                  </td>
                  <td className="px-4 py-3 text-black/60">{product.productType}</td>
                  <td className="px-4 py-3">{formatPriceMinor(product.basePriceMinor, product.currency)}</td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      disabled={togglePublish.isPending}
                      onClick={() => togglePublish.mutate({ id: product.id, published: !product.isPublished })}
                      className={`rounded-full px-3 py-1 text-xs font-medium disabled:opacity-40 ${
                        product.isPublished ? 'bg-green-600/10 text-green-700' : 'bg-black/10 text-black/50'
                      }`}
                    >
                      {product.isPublished ? 'Visible' : 'Hidden'}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <Link
                        href={`/admin/products/${product.id}/edit`}
                        className="rounded-md border border-black/20 px-3 py-1 text-xs hover:bg-black/5"
                      >
                        Edit
                      </Link>
                      {confirmingId === product.id ? (
                        <>
                          <button
                            type="button"
                            disabled={deleteProduct.isPending}
                            onClick={() => deleteProduct.mutate(product.id)}
                            className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
                          >
                            {deleteProduct.isPending ? 'Deleting…' : 'Confirm delete'}
                          </button>
                          <button
                            type="button"
                            disabled={deleteProduct.isPending}
                            onClick={() => setConfirmingId(null)}
                            className="rounded-md border border-black/20 px-3 py-1 text-xs hover:bg-black/5 disabled:opacity-40"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteError(null);
                            setConfirmingId(product.id);
                          }}
                          className="rounded-md border border-red-600/30 px-3 py-1 text-xs text-red-700 hover:bg-red-600/5"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.totalPages > 1 && (
        <div className="mt-4 flex items-center justify-center gap-3 text-sm">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="rounded-md border border-black/20 px-3 py-1 disabled:opacity-40"
          >
            Prev
          </button>
          <span className="text-black/50">
            Page {data.page} of {data.totalPages}
          </span>
          <button
            type="button"
            disabled={page >= data.totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-md border border-black/20 px-3 py-1 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
