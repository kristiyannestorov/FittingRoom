'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/auth-store';
import { Spinner } from '@/components/ui/state';

const SIDEBAR_LINKS = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/orders', label: 'Orders' },
  { href: '/admin/inventory', label: 'Inventory' },
  { href: '/admin/production', label: 'Production' },
  { href: '/admin/products', label: 'Products' },
  { href: '/admin/analytics', label: 'Analytics' },
  { href: '/admin/emails', label: 'Emails' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const tokens = useAuthStore((s) => s.tokens);
  const router = useRouter();
  const pathname = usePathname();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!tokens || user?.role !== 'ADMIN') {
      router.replace('/');
      return;
    }
    setChecked(true);
  }, [tokens, user, router]);

  if (!checked) {
    return <Spinner label="Checking access…" />;
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[180px_1fr]">
      <nav className="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible">
        {SIDEBAR_LINKS.map((link) => {
          const active = link.href === '/admin' ? pathname === '/admin' : pathname.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium ${
                active ? 'bg-ink text-paper' : 'text-black/60 hover:bg-black/5'
              }`}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
      <div>{children}</div>
    </div>
  );
}
