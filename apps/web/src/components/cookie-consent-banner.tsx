'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

const CONSENT_COOKIE = 'zed-cookie-consent';

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function writeConsentCookie(value: 'accepted' | 'declined') {
  const oneYear = 60 * 60 * 24 * 365;
  document.cookie = `${CONSENT_COOKIE}=${value}; max-age=${oneYear}; path=/; SameSite=Lax`;
}

export function CookieConsentBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(readCookie(CONSENT_COOKIE) === null);
  }, []);

  if (!visible) return null;

  const respond = (value: 'accepted' | 'declined') => {
    writeConsentCookie(value);
    setVisible(false);
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-black/10 bg-paper px-4 py-4 shadow-[0_-2px_10px_rgba(0,0,0,0.06)]">
      <div className="mx-auto flex max-w-6xl flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-black/70">
          We use cookies to keep you signed in and understand how the store is used. See our{' '}
          <Link href="/privacy" className="underline hover:text-ink">
            privacy policy
          </Link>{' '}
          for details.
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => respond('declined')}
            className="rounded-lg border border-black/20 px-4 py-2 text-sm hover:bg-black/5"
          >
            Decline
          </button>
          <button
            onClick={() => respond('accepted')}
            className="rounded-lg bg-ink px-4 py-2 text-sm text-paper hover:opacity-90"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
