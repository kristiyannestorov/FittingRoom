'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { cartApi } from '@/lib/api/cart';
import { useAuthStore } from '@/store/auth-store';
import { formatPriceMinor } from '@/lib/format';
import { Spinner, EmptyState } from '@/components/ui/state';

export default function CartPage() {
  const tokens = useAuthStore((s) => s.tokens);
  const queryClient = useQueryClient();
  const router = useRouter();

  const { data: cart, isLoading } = useQuery({
    queryKey: ['cart'],
    queryFn: cartApi.get,
    enabled: Boolean(tokens),
  });

  const updateQuantity = useMutation({
    mutationFn: ({ itemId, quantity }: { itemId: string; quantity: number }) =>
      cartApi.updateQuantity(itemId, quantity),
    onSuccess: (cart) => queryClient.setQueryData(['cart'], cart),
  });

  const remove = useMutation({
    mutationFn: (itemId: string) => cartApi.remove(itemId),
    onSuccess: (cart) => queryClient.setQueryData(['cart'], cart),
  });

  if (!tokens) {
    return (
      <div className="py-16 text-center">
        <p className="mb-4">Sign in to see your cart.</p>
        <Link href="/login" className="rounded-md bg-ink px-6 py-3 text-sm text-paper">
          Sign in
        </Link>
      </div>
    );
  }

  if (isLoading) return <Spinner label="Loading cart…" />;
  if (!cart || cart.items.length === 0) {
    return (
      <EmptyState
        title="Your cart is empty"
        action={
          <Link
            href="/products"
            className="mt-2 rounded-md bg-ink px-6 py-3 text-sm text-paper hover:bg-ink/90"
          >
            Browse the catalog
          </Link>
        }
      />
    );
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        {cart.items.map((item) => (
          <div key={item.id} className="flex gap-4 rounded-lg border border-black/10 p-4">
            <Link
              href={`/products/${item.productSlug}`}
              className="h-24 w-20 flex-shrink-0 overflow-hidden rounded bg-black/5"
            >
              {item.thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.thumbnailUrl}
                  alt={item.productName}
                  className="h-full w-full object-cover"
                />
              ) : null}
            </Link>
            <div className="flex flex-1 flex-col justify-between">
              <div>
                <div className="flex items-center justify-between">
                  <Link
                    href={`/products/${item.productSlug}`}
                    className="font-medium hover:text-accent"
                  >
                    {item.productName}
                  </Link>
                  {!item.available && (
                    <span className="text-xs text-red-600">No longer in stock</span>
                  )}
                </div>
                <p className="text-sm text-black/50">
                  {item.variantName} · Size {item.size}
                </p>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="h-7 w-7 rounded-full border border-black/20"
                    onClick={() =>
                      updateQuantity.mutate({ itemId: item.id, quantity: Math.max(0, item.quantity - 1) })
                    }
                  >
                    −
                  </button>
                  <span className="w-6 text-center text-sm">{item.quantity}</span>
                  <button
                    type="button"
                    className="h-7 w-7 rounded-full border border-black/20"
                    onClick={() => updateQuantity.mutate({ itemId: item.id, quantity: item.quantity + 1 })}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    onClick={() => remove.mutate(item.id)}
                    className="ml-3 text-xs text-black/40 underline"
                  >
                    Remove
                  </button>
                </div>
                <p className="font-medium">{formatPriceMinor(item.lineTotalMinor, cart.currency)}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="h-fit rounded-lg border border-black/10 p-6">
        <div className="flex justify-between text-sm text-black/60">
          <span>Subtotal</span>
          <span>{formatPriceMinor(cart.subtotalMinor, cart.currency)}</span>
        </div>
        <p className="mt-1 text-xs text-black/40">Shipping calculated at checkout</p>
        <button
          type="button"
          onClick={() => router.push('/checkout')}
          className="mt-6 w-full rounded-md bg-ink px-6 py-3 text-sm font-medium text-paper"
        >
          Checkout
        </button>
      </div>
    </div>
  );
}
