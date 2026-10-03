'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/store/auth-store';
import { cartApi } from '@/lib/api/cart';

export function Nav() {
  const user = useAuthStore((s) => s.user);
  const clear = useAuthStore((s) => s.clear);
  const tokens = useAuthStore((s) => s.tokens);

  const { data: cart } = useQuery({
    queryKey: ['cart'],
    queryFn: cartApi.get,
    enabled: Boolean(tokens),
  });

  return (
    <header className="sticky top-0 z-30 border-b border-black/10 bg-paper/95 backdrop-blur">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          ProjectZed
        </Link>

        <div className="flex items-center gap-6 text-sm">
          <Link href="/products" className="hover:text-accent">
            Catalog
          </Link>
          <Link href="/fitting-room" className="hover:text-accent">
            Fitting room
          </Link>
          {tokens && (
            <Link href="/orders" className="hover:text-accent">
              Orders
            </Link>
          )}
          {user?.role === 'ADMIN' && (
            <Link href="/admin" className="hover:text-accent">
              Admin
            </Link>
          )}

          <Link href="/cart" className="hover:text-accent">
            Cart{cart && cart.itemCount > 0 ? ` (${cart.itemCount})` : ''}
          </Link>

          {tokens ? (
            <button
              type="button"
              onClick={clear}
              className="rounded-md border border-black/20 px-3 py-1 hover:bg-black/5"
            >
              Sign out
            </button>
          ) : (
            <Link
              href="/login"
              className="rounded-md border border-black/20 px-3 py-1 hover:bg-black/5"
            >
              Sign in
            </Link>
          )}
        </div>
      </nav>
    </header>
  );
}
